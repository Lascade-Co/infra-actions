// B1: Cloudflare reconcile (ported from the infra-sync Worker). See README.md in this folder.

import type { DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";
import { applyOps } from "./apply.js";
import { CfClient } from "./client.js";
import { toOps } from "./ops.js";
import { adaptDroplets, buildPlan, cfgFrom, snapshotFrom } from "./plan.js";
import type { CloudflareObserved } from "./types.js";

export type * from "./types.js";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function cloudflareClient(ctx: RunContext): CfClient {
  return CfClient.create({
    token: ctx.secrets.require("CF_API_TOKEN"),
    accountId: ctx.account.cloudflare.account_id,
    fetch: ctx.fetch,
    allowWrites: ctx.allowWrites,
  });
}

/**
 * Read-only: zones (account), infrastructure targets, Access apps, the configuration of every
 * tunnel in account.cloudflare.tunnels, and every DNS record of every zone. A failed tunnel or
 * zone read is kept as { error } so the plan can fail closed (no deletes), as in the Worker; a
 * failed zone, target or app listing (or no zones at all) throws: nothing is planned.
 */
export async function observeCloudflare(ctx: RunContext): Promise<CloudflareObserved> {
  const cf = cloudflareClient(ctx);
  const zones = await cf.listZones();
  if (!zones.length) throw new Error("Cloudflare returned zero zones; refusing to plan");
  const targets = await cf.listTargets();
  const apps = await cf.listAccessApps();
  const tunnels: CloudflareObserved["tunnels"] = {};
  for (const tid of new Set(Object.values(ctx.account.cloudflare.tunnels))) {
    try {
      tunnels[tid] = await cf.getTunnelConfig(tid);
    } catch (e) {
      tunnels[tid] = { error: errText(e) };
    }
  }
  const dns: CloudflareObserved["dns"] = {};
  for (const z of zones) {
    try {
      dns[z.id] = await cf.listDnsRecords(z.id);
    } catch (e) {
      dns[z.id] = { error: errText(e) };
    }
  }
  return { zones, targets, apps, tunnels, dns };
}

/**
 * Pure: the Worker's buildPlan/planWeb, with droplet files as input instead of tags +
 * web-config.json, plus allow.tunnel routes and service-token exceptions. Only objects carrying
 * the infra-sync marker are ever updated or deleted. Refuses to plan (one error, no ops) when the
 * account's zones differ from account.cloudflare.zones, because names flatten against the zones.
 */
export function planCloudflare(desired: DesiredState, observed: CloudflareObserved): ModulePlan {
  const want = [...new Set(desired.account.cloudflare.zones.map((z) => z.toLowerCase()))].sort();
  const have = [...new Set(observed.zones.map((z) => z.name.toLowerCase()))].sort();
  if (want.join() !== have.join()) {
    const missing = want.filter((z) => !have.includes(z));
    const extra = have.filter((z) => !want.includes(z));
    return {
      module: "cloudflare",
      ops: [],
      unchanged: 0,
      diagnostics: [
        {
          level: "error",
          code: "cloudflare-zones",
          file: "account.yaml",
          path: "cloudflare.zones",
          message: `the account's zones differ from account.yaml (${[missing.length ? `not in the account: ${missing.join(", ")}` : "", extra.length ? `not in account.yaml: ${extra.join(", ")}` : ""].filter(Boolean).join("; ")}); names flatten against the zones, so nothing is planned until they match`,
        },
      ],
    };
  }
  const snap = snapshotFrom(observed);
  const plan = buildPlan(snap, cfgFrom(desired.account), adaptDroplets(desired));
  const { ops, unchanged } = toOps(plan, snap, desired);
  const sourceOf = new Map(desired.droplets.map((d) => [d.name, d.source]));
  const diagnostics: Diagnostic[] = plan.diagnostics.map((d) => ({
    level: d.level,
    code: d.code,
    message: d.message,
    ...(d.droplet ? { droplet: d.droplet } : {}),
    ...(d.droplet && sourceOf.has(d.droplet) ? { file: sourceOf.get(d.droplet)! } : {}),
  }));
  return { module: "cloudflare", ops, unchanged, diagnostics };
}

/** Performs the ops in the Worker's fail-closed order (create: target -> app -> ingress -> DNS; delete: DNS -> ingress -> app -> target). */
export async function applyCloudflare(ctx: RunContext, ops: PlanOp[], _observed: CloudflareObserved): Promise<ApplyResult> {
  return applyOps(cloudflareClient(ctx), ops);
}

export function createCloudflareProvider(ctx: RunContext): Provider<CloudflareObserved> {
  return {
    module: "cloudflare",
    observe: () => observeCloudflare(ctx),
    diff: (desired, observed) => planCloudflare(desired, observed),
    apply: (ops, observed) => applyCloudflare(ctx, ops, observed),
  };
}
