// Apply in the Worker's fail-closed order (src/sync.ts there), from the ops alone.
//
//   SSH access set apps first (decision 18), so a retagged target always finds its set's app
//   creates/updates per hostname: target -> Access app -> tunnel route -> DNS
//   sites: exception apps, then gating apps -> route (only once every gating app is in place) -> CNAME
//   deletes per hostname: DNS -> route -> Access app -> target, stopping at the first failure
//   then vpc- records, healthcheck bypass apps, the infrastructure apps no set wants, and last
//   the WAF custom rule of each zone (decision 21), one rule at a time
//
// An op runs only when every op it depends on (ids.deps) that is in this apply succeeded. Each
// tunnel configuration is read fresh, changed and written back as one document; a route op whose
// rules changed since the plan fails rather than overwrite them.

import type { ApplyResult, OpFailure, PlanOp } from "../core/plan.js";
import type { CfClient } from "./client.js";
import { mergeIngress, rulesFor, sameGroup, type UpsertTarget } from "./ingress.js";
import { PHASE } from "./ops.js";
import type { IngressRule } from "./types.js";
import { wafRuleBody } from "./waf.js";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const ref = (op: PlanOp) => `${op.kind} ${op.key}`;
const phaseOf = (op: PlanOp) => Number(op.ids?.phase ?? 0);
const depsOf = (op: PlanOp): string[] => (op.ids?.deps ? (JSON.parse(op.ids.deps) as string[]) : []);
const rulesIn = (x: unknown): IngressRule[] => ((x as { rules?: IngressRule[] } | null)?.rules ?? []);
/** "<tunnel id> <hostname>" */
const hostOf = (op: PlanOp) => op.key.slice(op.key.indexOf(" ") + 1);

type Status = "ok" | "failed" | "skipped";

export async function applyOps(cf: CfClient, input: PlanOp[]): Promise<ApplyResult> {
  const applied: PlanOp[] = [];
  const failed: OpFailure[] = [];
  const skipped: Array<{ op: PlanOp; reason: string }> = [];
  const status = new Map<string, Status>();

  const ops = input
    .filter((op) => {
      if (op.action !== "report" && !op.pending) return true;
      skipped.push({ op, reason: op.action === "report" ? "report-only" : "waiting for a droplet that isn't up yet" });
      return false;
    })
    .map((op, i) => ({ op, i }))
    .sort((a, b) => phaseOf(a.op) - phaseOf(b.op) || a.i - b.i)
    .map(({ op }) => op);

  const ok = (op: PlanOp) => {
    applied.push(op);
    status.set(ref(op), "ok");
  };
  const fail = (op: PlanOp, error: string) => {
    failed.push({ op, error });
    status.set(ref(op), "failed");
  };
  /** The first dependency in this apply that did not succeed. */
  const blockedBy = (op: PlanOp) => depsOf(op).find((d) => status.has(d) && status.get(d) !== "ok");
  const ready = (op: PlanOp): boolean => {
    const b = blockedBy(op);
    if (!b) return true;
    skipped.push({ op, reason: `not done: ${b} did not succeed (fail closed)` });
    status.set(ref(op), "skipped");
    return false;
  };

  const perform = async (op: PlanOp): Promise<void> => {
    const id = op.ids?.id ?? "";
    const zone = op.ids?.zone ?? "";
    switch (op.kind) {
      case "infra-target":
        if (op.action === "create") await cf.createTarget(op.after);
        else if (op.action === "update") await cf.updateTarget(id, op.after);
        else await cf.deleteTarget(id);
        return;
      case "infra-app":
      case "access-app":
        if (op.action === "create") await cf.createApp(op.after);
        else if (op.action === "update") await cf.updateApp(id, op.after);
        else await cf.deleteApp(id);
        return;
      case "dns-record":
        if (op.action === "create") await cf.createDns(zone, op.after);
        else if (op.action === "update") await cf.patchDns(zone, id, op.after);
        else await cf.deleteDns(zone, id);
        return;
      case "waf-rule": {
        // The body is rebuilt from the hosts the plan showed. A zone with no entry point ruleset
        // gets one holding only this rule; otherwise only this rule is added (first, so no other
        // rule's skip can bypass it), patched or deleted.
        const rs = op.ids?.ruleset ?? "";
        const hosts = ((op.after as { hosts?: string[] } | null)?.hosts ?? []).map(String);
        if (op.action === "create") {
          if (rs) await cf.addWafRule(zone, rs, { ...wafRuleBody(hosts), position: { before: "" } });
          else await cf.createWafEntrypoint(zone, wafRuleBody(hosts));
        } else if (op.action === "update") await cf.updateWafRule(zone, rs, id, wafRuleBody(hosts));
        else await cf.deleteWafRule(zone, rs, id);
        return;
      }
      default:
        throw new Error(`cloudflare apply does not handle ${op.kind}`);
    }
  };

  /** One read-modify-write per tunnel for the route ops of one phase (plus fail-closed removals). */
  const tunnelPhase = async (phaseOps: PlanOp[], withFailRemoves: boolean) => {
    const byTunnel = new Map<string, PlanOp[]>();
    for (const op of phaseOps) {
      const tid = op.ids?.tunnel ?? "";
      byTunnel.set(tid, [...(byTunnel.get(tid) ?? []), op]);
    }
    // Fail closed: an app whose create failed (or never ran) must not leave its route up.
    const failRemoves: Array<{ tunnel: string; hostname: string; rules: IngressRule[]; source: PlanOp }> = [];
    if (withFailRemoves) {
      for (const op of ops) {
        if (!op.ids?.failRemove || phaseOf(op) >= PHASE.ingress || status.get(ref(op)) === "ok") continue;
        const fr = JSON.parse(op.ids.failRemove) as { tunnel: string; hostname: string; rules: IngressRule[] };
        failRemoves.push({ ...fr, source: op });
        if (!byTunnel.has(fr.tunnel)) byTunnel.set(fr.tunnel, []);
      }
    }
    for (const [tid, list] of byTunnel) {
      const runnable = list.filter(ready);
      const removals = failRemoves.filter((f) => f.tunnel === tid && !runnable.some((op) => hostOf(op) === f.hostname));
      if (!runnable.length && !removals.length) continue;
      let fresh;
      try {
        fresh = await cf.getTunnelConfig(tid);
        if (fresh.source !== "cloudflare") throw new Error(`tunnel ${tid} is not remotely managed (source=${fresh.source})`);
      } catch (e) {
        for (const op of runnable) fail(op, `tunnel ${tid} configuration: ${errText(e)}`);
        for (const r of removals) failed.push({ op: removalOp(tid, r), error: `tunnel ${tid} configuration: ${errText(e)}` });
        continue;
      }
      const upserts = new Map<string, UpsertTarget>();
      const removes = new Set<string>();
      const owned = new Set<string>();
      const included: PlanOp[] = [];
      const alreadyDone: PlanOp[] = [];
      for (const op of runnable) {
        const h = hostOf(op);
        const current = rulesFor(fresh.config, h);
        const after = rulesIn(op.after);
        if (op.action === "delete" ? current.length === 0 : sameGroup(current, after)) {
          alreadyDone.push(op); // someone (or an earlier run) already did it
          continue;
        }
        if (op.action === "create" ? current.length > 0 : !sameGroup(current, rulesIn(op.before))) {
          fail(op, `tunnel ${tid}: the rules for ${h} changed since the plan; not overwritten`);
          continue;
        }
        if (op.action === "delete") removes.add(h);
        else upserts.set(h, { rules: after });
        if (op.action !== "create") owned.add(h);
        included.push(op);
      }
      const removalOps: PlanOp[] = [];
      for (const r of removals) {
        const current = rulesFor(fresh.config, r.hostname);
        if (!current.length) continue;
        const op = removalOp(tid, r);
        if (!sameGroup(current, r.rules)) {
          failed.push({ op, error: `tunnel ${tid}: the rules for ${r.hostname} changed since the plan; not removed` });
          continue;
        }
        removes.add(r.hostname);
        owned.add(r.hostname);
        removalOps.push(op);
      }
      const merged = mergeIngress(fresh.config, { upserts, removes, owned, ownedWeb: owned });
      const conflicted = included.filter((op) => merged.conflicts.includes(hostOf(op)));
      for (const op of conflicted) fail(op, `tunnel ${tid}: ${hostOf(op)} collides with a rule the tool does not own`);
      const written = included.filter((op) => !conflicted.includes(op));
      for (const op of alreadyDone) ok(op);
      if (!merged.changed) {
        for (const op of written) ok(op);
        continue;
      }
      try {
        await cf.putTunnelConfig(tid, merged.config);
        for (const op of written) ok(op);
        applied.push(...removalOps);
      } catch (e) {
        for (const op of written) fail(op, `tunnel ${tid} configuration: ${errText(e)}`);
        for (const op of removalOps) failed.push({ op, error: `tunnel ${tid} configuration: ${errText(e)}` });
      }
    }
  };

  const phases = [...new Set(ops.map(phaseOf))].sort((a, b) => a - b);
  if (!phases.includes(PHASE.ingress) && ops.some((op) => op.ids?.failRemove)) phases.push(PHASE.ingress);
  phases.sort((a, b) => a - b);
  for (const p of phases) {
    const phaseOps = ops.filter((op) => phaseOf(op) === p);
    if (p === PHASE.ingress || p === PHASE.moved) {
      await tunnelPhase(phaseOps, p === PHASE.ingress);
      continue;
    }
    for (const op of phaseOps) {
      if (!ready(op)) continue;
      try {
        await perform(op);
        ok(op);
      } catch (e) {
        fail(op, errText(e));
      }
    }
  }
  return { module: "cloudflare", applied, failed, skipped };
}

function removalOp(tid: string, r: { hostname: string; rules: IngressRule[]; source: PlanOp }): PlanOp {
  return {
    provider: "cloudflare",
    module: "cloudflare",
    kind: "tunnel-ingress",
    key: `${tid} ${r.hostname}`,
    action: "delete",
    before: JSON.parse(JSON.stringify({ rules: r.rules })),
    after: null,
    reason: `fail closed: ${r.source.key} could not be put in place, so its route is taken down rather than left without Access`,
    ...(r.source.droplet ? { droplet: r.source.droplet } : {}),
    ids: { tunnel: tid },
  };
}
