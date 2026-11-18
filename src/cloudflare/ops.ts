// Plan (the Worker's shape) -> PlanOps (the tool's plan format).
//
// Each op carries everything apply needs, because apply gets only the ops the engine lets through
// (no report ops, nothing for a frozen droplet, nothing pending) plus the observed state:
//   after       the request body (or, for a tunnel route, the rule group to write)
//   before      what is there now (for a tunnel route, the rule group apply expects to find)
//   ids.id      the object's id (update, delete); ids.zone; ids.tunnel
//   ids.phase   the step in the Worker's order (sync.ts there), see PHASE
//   ids.deps    JSON list of "<kind> <key>" refs that must have succeeded first, if they are in
//               the apply list; one that isn't is already in place
//   ids.failRemove  JSON {tunnel, hostname, rules}: the route to take down if this app op does not
//               succeed (fail closed: never leave a route up without its Access app)

import type { DesiredState } from "../core/desired.js";
import type { Json, PlanOp } from "../core/plan.js";
import { flattenName } from "../core/naming.js";
import { appDestinations, appDomains, lc, webAppKind } from "./bodies.js";
import { mergeIngress, rulesFor, type UpsertTarget } from "./ingress.js";
import type { Plan, Snapshot } from "./plan.js";
import type { AccessApp, AccessPolicy, DnsRecord, IngressRule, InfraTarget, ReadError, TunnelConfiguration } from "./types.js";

export const PHASE = {
  target: 1,
  sshApp: 2,
  siteApp: 3,
  routeApp: 4,
  dnsDelete: 5,
  ingress: 6,
  moved: 7,
  sshDns: 8,
  siteDns: 9,
  routeDns: 10,
  sshAppDelete: 11,
  siteAppDelete: 12,
  routeAppDelete: 13,
  targetDelete: 14,
  vpc: 15,
  vpcDelete: 16,
  health: 17,
  healthDelete: 18,
  infraApp: 19,
} as const;

/** Role of an op in its hostname's chain (see deps below). */
type Role = "T" | "A" | "G" | "E" | "I" | "D" | "M" | "XD" | "XI" | "XA" | "XW" | "XT" | "free";

interface Draft {
  op: PlanOp;
  phase: number;
  role: Role;
  /** "ssh <h>" | "site <h>" | "route <h>" */
  chain?: string;
  /** XA: chains of every hostname the app covers. */
  chains?: string[];
  /** XA: a duplicate of a wanted app; its deletion depends on nothing. */
  dupExempt?: boolean;
  /** XW: an exception app (can always go). */
  exception?: boolean;
  /** XW: the site has 404 rules (its old apps go only once the route is live). */
  notFound?: boolean;
}

const isErr = (x: unknown): x is ReadError => !!x && typeof x === "object" && "error" in x;
const j = (x: unknown): Json => JSON.parse(JSON.stringify(x ?? null)) as Json;

function appView(a: AccessApp): Json {
  const pol = (p: AccessPolicy) => (p.reusable ? { reusable_policy: p.id ?? null, precedence: p.precedence ?? null } : { name: p.name, decision: p.decision, include: p.include, precedence: p.precedence ?? null });
  return j({
    name: a.name,
    type: a.type,
    destinations: appDestinations(a),
    ...(a.allow_authenticate_via_warp !== undefined ? { allow_authenticate_via_warp: a.allow_authenticate_via_warp } : {}),
    ...(a.target_criteria ? { target_criteria: a.target_criteria } : {}),
    policies: (a.policies ?? []).map(pol),
  });
}
const dnsView = (r: DnsRecord): Json => j({ type: r.type, name: r.name, content: r.content, proxied: r.proxied ?? null, ttl: r.ttl ?? null, comment: r.comment ?? null });
const targetView = (t: InfraTarget): Json => j({ hostname: t.hostname, ip: t.ip, tags: t.tags ?? {} });

export interface OpsResult {
  ops: PlanOp[];
  unchanged: number;
}

export function toOps(plan: Plan, snap: Snapshot, desired: DesiredState): OpsResult {
  const drafts: Draft[] = [];
  let unchanged = 0;
  const zoneNames = snap.zones.map((z) => lc(z.name));

  // Which droplet file an object belongs to (frozen droplets, grouping in the PR comment).
  const fileNames = new Set(desired.droplets.map((d) => d.name));
  const byGenerated = new Map<string, string>();
  for (const d of desired.droplets) {
    if (d.sshHostname) byGenerated.set(d.sshHostname, d.name);
    if (d.vpcHostname) byGenerated.set(d.vpcHostname, d.name);
  }
  const routeOwner = new Map<string, string>();
  for (const d of desired.droplets) for (const t of d.spec.allow.tunnel) routeOwner.set(lc(t.route), d.name);
  // A hostname no file lists any more (e.g. removed from a frozen droplet's web.hostnames): the
  // droplet whose private IP its current route points at.
  const byIp = new Map<string, string>();
  for (const d of desired.droplets) if (d.privateIpv4) byIp.set(d.privateIpv4, d.name);
  const ownerByRoute = (h: string): string | undefined => {
    for (const tc of Object.values(snap.tunnels)) {
      if (isErr(tc)) continue;
      const main = rulesFor(tc.config, h).find((r) => !r.path);
      const ip = main ? /^[a-z]+:\/\/([^:/]+)/i.exec(main.service)?.[1] : undefined;
      if (ip && byIp.has(ip)) return byIp.get(ip);
    }
    return undefined;
  };
  const ownerOfName = (name: string): string | undefined => {
    const n = lc(name);
    if (fileNames.has(n)) return n;
    if (byGenerated.has(n)) return byGenerated.get(n);
    if (routeOwner.has(n)) return routeOwner.get(n);
    const o = plan.ownerOf(n);
    return fileNames.has(o) ? o : ownerByRoute(n);
  };

  const add = (d: Omit<Draft, "op"> & { op: Omit<PlanOp, "provider" | "module"> }, pending = false) => {
    const op: PlanOp = { provider: "cloudflare", module: "cloudflare", ...d.op };
    if (pending) op.pending = true;
    if (!op.droplet) delete op.droplet;
    drafts.push({ ...d, op });
  };
  const del = plan.deletionsAllowed ? ("delete" as const) : ("report" as const);
  const delReason = (why: string) => (plan.deletionsAllowed ? why : `${why}; not deleted this run: ${plan.deletionBlockReason}`);
  const opAction = (o: "create" | "update") => o;

  // ---------- creates and updates ----------

  for (const h of plan.hosts) {
    const t = h.target;
    if (t.op === "noop") unchanged++;
    else
      add(
        {
          phase: PHASE.target,
          role: "T",
          chain: `ssh ${h.sshHostname}`,
          op: {
            kind: "infra-target",
            key: h.name,
            action: opAction(t.op),
            before: t.existing ? targetView(t.existing) : null,
            after: j(t.body),
            reason: t.op === "create" ? "SSH target for a managed droplet" : t.existing?.hostname !== h.name ? "the droplet was renamed (same private IP)" : "the droplet's private IP changed",
            droplet: h.name,
            ...(t.existingId ? { ids: { id: t.existingId } } : {}),
          },
        },
        h.pending,
      );
    if (h.hostnameBlocked) continue;
    if (h.app) {
      if (h.app.op === "noop") unchanged++;
      else
        add(
          {
            phase: PHASE.sshApp,
            role: "A",
            chain: `ssh ${h.sshHostname}`,
            op: {
              kind: "access-app",
              key: h.sshHostname,
              action: opAction(h.app.op),
              before: h.app.existing ? appView(h.app.existing) : null,
              after: j(h.app.body),
              reason: h.app.op === "create" ? "Access app for the droplet's SSH route" : "the SSH route's Access policies changed (admins or CI deploy tokens)",
              droplet: h.name,
              ids: {
                ...(h.app.existingId ? { id: h.app.existingId } : {}),
                ...(h.app.op === "create" ? failRemove(snap, h.tunnelId, h.sshHostname) : {}),
              },
            },
          },
          h.pending,
        );
    }
    if (h.dns) {
      if (h.dns.op === "noop") unchanged++;
      else
        add(
          {
            phase: PHASE.sshDns,
            role: "D",
            chain: `ssh ${h.sshHostname}`,
            op: {
              kind: "dns-record",
              key: `CNAME ${h.sshHostname}`,
              action: opAction(h.dns.op),
              before: h.dns.existing ? dnsView(h.dns.existing) : null,
              after: j(h.dns.body),
              reason: h.dns.op === "create" ? "SSH route name, to the region's tunnel" : "the SSH route name points at the wrong tunnel",
              droplet: h.name,
              ids: { zone: h.zoneId, ...(h.dns.existingId ? { id: h.dns.existingId } : {}) },
            },
          },
          h.pending,
        );
    }
  }

  for (const s of plan.web) {
    for (const a of s.apps) {
      if (a.op === "noop") {
        unchanged++;
        continue;
      }
      const unprotected = a.op === "create" || a.existingKind !== a.kind;
      add(
        {
          phase: PHASE.siteApp,
          role: a.gating ? "G" : "E",
          chain: `site ${s.hostname}`,
          op: {
            kind: "access-app",
            key: a.destination,
            action: opAction(a.op),
            before: a.existing ? appView(a.existing) : null,
            after: j(a.body),
            reason:
              a.kind === "site"
                ? `staff login for the whole site ${s.hostname}`
                : a.kind === "admin"
                  ? `staff login for the protected path ${a.destination}`
                  : `exception path ${a.destination}`,
            droplet: s.name,
            ids: {
              ...(a.existingId ? { id: a.existingId } : {}),
              ...(a.gating && unprotected && !s.hasHostApp ? failRemove(snap, s.tunnelId, s.hostname) : {}),
            },
          },
        },
        s.pending,
      );
    }
    if (s.dns) {
      if (s.dns.op === "noop") unchanged++;
      else
        add(
          {
            phase: PHASE.siteDns,
            role: "D",
            chain: `site ${s.hostname}`,
            op: {
              kind: "dns-record",
              key: `CNAME ${s.hostname}`,
              action: opAction(s.dns.op),
              before: s.dns.existing ? dnsView(s.dns.existing) : null,
              after: j(s.dns.body),
              reason: s.dns.op === "create" ? "site name, to the region's tunnel (nothing else holds the name)" : "the site name points at the wrong tunnel",
              droplet: s.name,
              ids: { zone: s.zoneId, ...(s.dns.existingId ? { id: s.dns.existingId } : {}) },
            },
          },
          s.pending,
        );
    }
  }

  for (const r of plan.routes) {
    if (r.app.op === "noop") unchanged++;
    else
      add(
        {
          phase: PHASE.routeApp,
          role: "A",
          chain: `route ${r.hostname}`,
          op: {
            kind: "access-app",
            key: r.hostname,
            action: opAction(r.app.op),
            before: r.app.existing ? appView(r.app.existing) : null,
            after: j(r.app.body),
            reason: r.app.op === "create" ? `Access app for the tunnel route ${r.hostname} (allow.tunnel)` : `who may use the tunnel route ${r.hostname} changed`,
            droplet: r.name,
            ids: { ...(r.app.existingId ? { id: r.app.existingId } : {}), ...(r.app.op === "create" ? failRemove(snap, r.tunnelId, r.hostname) : {}) },
          },
        },
        r.pending,
      );
    if (r.dns.op === "noop") unchanged++;
    else
      add(
        {
          phase: PHASE.routeDns,
          role: "D",
          chain: `route ${r.hostname}`,
          op: {
            kind: "dns-record",
            key: `CNAME ${r.hostname}`,
            action: opAction(r.dns.op),
            before: r.dns.existing ? dnsView(r.dns.existing) : null,
            after: j(r.dns.body),
            reason: r.dns.op === "create" ? "tunnel route name, to the region's tunnel" : "the tunnel route name points at the wrong tunnel",
            droplet: r.name,
            ids: { zone: r.zoneId, ...(r.dns.existingId ? { id: r.dns.existingId } : {}) },
          },
        },
        r.pending,
      );
  }
  for (const r of plan.routeReports) {
    add({
      phase: PHASE.ingress,
      role: "free",
      op: {
        kind: "tunnel-ingress",
        key: `(not built) ${r.hostname}`,
        action: "report",
        before: null,
        after: j({ route: r.hostname, port: r.port, who: r.who.map((w) => (w.kind === "staff" ? "staff" : `service-token:${w.name}`)) }),
        reason: r.reason,
        droplet: r.name,
      },
    });
  }

  // ---------- tunnel ingress: one merge per tunnel, one op per hostname ----------

  const sshHost = new Map(plan.hosts.filter((h) => !h.hostnameBlocked).map((h) => [h.sshHostname, h]));
  const siteHost = new Map(plan.web.map((s) => [s.hostname, s]));
  const routeHost = new Map(plan.routes.map((r) => [r.hostname, r]));
  const chainOf = (h: string) => (routeHost.has(h) || plan.ownedRouteHostnames.has(h) ? `route ${h}` : h.startsWith("ssh-") ? `ssh ${h}` : `site ${h}`);
  const ownedWeb = new Set([...plan.ownedWebHostnames, ...plan.ownedRouteHostnames]);
  const gone = [...plan.staleIngress, ...plan.staleWebIngress, ...plan.staleRouteIngress].filter((s) => s.reason === "gone");
  const moved = [...plan.staleIngress, ...plan.staleWebIngress, ...plan.staleRouteIngress].filter((s) => s.reason === "moved");

  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc) || tc.source !== "cloudflare") continue;
    const upserts = new Map<string, UpsertTarget>();
    const pendingHosts = new Set<string>();
    const dropletOf = new Map<string, string>();
    for (const h of plan.hosts) {
      if (h.tunnelId !== tid || h.hostnameBlocked) continue;
      upserts.set(h.sshHostname, h.ingressService);
      dropletOf.set(h.sshHostname, h.name);
      if (h.pending) pendingHosts.add(h.sshHostname);
    }
    for (const s of plan.web) {
      if (s.tunnelId !== tid) continue;
      upserts.set(s.hostname, s.ingress);
      dropletOf.set(s.hostname, s.name);
      if (s.pending) pendingHosts.add(s.hostname);
    }
    for (const r of plan.routes) {
      if (r.tunnelId !== tid) continue;
      upserts.set(r.hostname, r.ingressService);
      dropletOf.set(r.hostname, r.name);
      if (r.pending) pendingHosts.add(r.hostname);
    }
    const removes = new Set<string>();
    if (plan.deletionsAllowed) for (const s of gone) if (s.tunnelId === tid) removes.add(s.hostname);
    const merged = mergeIngress(tc.config, { upserts, removes, owned: plan.ownedHostnames, ownedWeb });
    for (const h of upserts.keys()) {
      if (!merged.added.includes(h) && !merged.updated.includes(h) && !merged.conflicts.includes(h)) unchanged++;
    }
    const groupOf = (h: string) => ({ rules: rulesFor(merged.config, h) });
    for (const h of [...merged.added, ...merged.updated]) {
      const target = upserts.get(h);
      const isNew = merged.added.includes(h);
      add(
        {
          phase: PHASE.ingress,
          role: "I",
          chain: chainOf(h),
          op: {
            kind: "tunnel-ingress",
            key: `${tid} ${h}`,
            action: isNew ? "create" : "update",
            before: isNew ? null : j({ rules: rulesFor(tc.config, h) }),
            after: j(target === undefined ? groupOf(h) : { rules: groupRules(h, target) }),
            reason: isNew ? routeReason(h, chainOf(h)) : target === undefined ? `a shadowed copy of the route ${h} is dropped` : `the route ${h} changed`,
            ...(ownerOfName(h) ?? dropletOf.get(h) ? { droplet: (ownerOfName(h) ?? dropletOf.get(h))! } : {}),
            ids: { tunnel: tid },
          },
        },
        pendingHosts.has(h),
      );
    }
    for (const h of merged.conflicts) {
      add({
        phase: PHASE.ingress,
        role: "free",
        op: {
          kind: "tunnel-ingress",
          key: `${tid} ${h}`,
          action: "report",
          before: j({ rules: rulesFor(tc.config, h) }),
          after: null,
          reason: `${h} collides with a rule the tool does not own; not changed`,
          ...(ownerOfName(h) ? { droplet: ownerOfName(h)! } : {}),
        },
      });
    }
    // Gone routes (merged.removed when deletions are allowed; report ops otherwise).
    for (const s of gone) {
      if (s.tunnelId !== tid) continue;
      if (plan.deletionsAllowed && !merged.removed.includes(s.hostname)) continue;
      add({
        phase: PHASE.ingress,
        role: "XI",
        chain: chainOf(s.hostname),
        op: {
          kind: "tunnel-ingress",
          key: `${tid} ${s.hostname}`,
          action: del,
          before: j({ rules: rulesFor(tc.config, s.hostname) }),
          after: null,
          reason: delReason(`no droplet file wants the route ${s.hostname} any more`),
          ...(ownerOfName(s.hostname) ? { droplet: ownerOfName(s.hostname)! } : {}),
          ids: { tunnel: tid },
        },
      });
    }
  }
  for (const s of moved) {
    const tc = snap.tunnels[s.tunnelId];
    if (!tc || isErr(tc)) continue;
    add({
      phase: PHASE.moved,
      role: "M",
      chain: chainOf(s.hostname),
      op: {
        kind: "tunnel-ingress",
        key: `${s.tunnelId} ${s.hostname}`,
        action: del,
        before: j({ rules: rulesFor(tc.config, s.hostname) }),
        after: null,
        reason: delReason(`the droplet moved to another region's tunnel; the old route ${s.hostname} goes once the new one is live`),
        ...(ownerOfName(s.hostname) ? { droplet: ownerOfName(s.hostname)! } : {}),
        ids: { tunnel: s.tunnelId },
      },
    });
  }

  // ---------- deletes (DNS -> ingress (above) -> apps -> targets) ----------

  const dnsDelete = (list: Array<{ zoneId: string; record: DnsRecord }>, chainPrefix: string, why: (r: DnsRecord) => string) => {
    for (const { zoneId, record } of list) {
      const name = lc(record.name);
      add({
        phase: PHASE.dnsDelete,
        role: "XD",
        chain: `${chainPrefix} ${name}`,
        op: {
          kind: "dns-record",
          key: `${record.type} ${name}`,
          action: del,
          before: dnsView(record),
          after: null,
          reason: delReason(why(record)),
          ...(ownerOfName(name) ? { droplet: ownerOfName(name)! } : {}),
          ids: { zone: zoneId, id: record.id },
        },
      });
    }
  };
  const wantedSsh = new Set(sshHost.keys());
  dnsDelete(plan.staleDns, "ssh", (r) => (wantedSsh.has(lc(r.name)) ? "a duplicate of the tool's own record" : "no droplet file has this SSH route any more"));
  dnsDelete(plan.staleWebDns, "site", (r) => (siteHost.has(lc(r.name)) ? "a duplicate of the tool's own record" : "no droplet file has this site hostname any more"));
  dnsDelete(plan.staleRouteDns, "route", (r) => (routeHost.has(lc(r.name)) ? "a duplicate of the tool's own record" : "no droplet file has this tunnel route any more"));

  for (const a of plan.staleApps) {
    const ds = appDomains(a);
    const dup = ds.length === 1 && wantedSsh.has(ds[0]!);
    add({
      phase: PHASE.sshAppDelete,
      role: "XA",
      chains: ds.map((d) => `ssh ${d}`),
      dupExempt: dup,
      op: {
        kind: "access-app",
        key: appDestinations(a).join(",") || a.name || a.id,
        action: del,
        before: appView(a),
        after: null,
        reason: delReason(dup ? "a duplicate of the SSH route's Access app" : "no droplet file has this SSH route any more"),
        ...(ds[0] && ownerOfName(ds[0]) ? { droplet: ownerOfName(ds[0])! } : {}),
        ids: { id: a.id },
      },
    });
  }
  for (const a of plan.staleWebApps) {
    const hosts = appDomains(a);
    const site = hosts.length === 1 ? siteHost.get(hosts[0]!) : undefined;
    const kind = webAppKind(a.name);
    add({
      phase: PHASE.siteAppDelete,
      role: site ? "XW" : "XA",
      ...(site ? { chain: `site ${site.hostname}`, exception: kind === "exception", notFound: !!site.ingress.notFoundPaths?.length } : { chains: hosts.map((h) => `site ${h}`) }),
      op: {
        kind: "access-app",
        key: appDestinations(a).join(",") || a.name || a.id,
        action: del,
        before: appView(a),
        after: null,
        reason: delReason(site ? "the site no longer plans this Access app (exposure, path or exception changed, or a duplicate)" : "no droplet file has this site hostname any more"),
        ...(hosts[0] && ownerOfName(hosts[0]) ? { droplet: ownerOfName(hosts[0])! } : {}),
        ids: { id: a.id },
      },
    });
  }
  for (const a of plan.staleRouteApps) {
    const hosts = appDomains(a);
    const dup = hosts.length === 1 && routeHost.has(hosts[0]!);
    add({
      phase: PHASE.routeAppDelete,
      role: "XA",
      chains: hosts.map((h) => `route ${h}`),
      dupExempt: dup,
      op: {
        kind: "access-app",
        key: appDestinations(a).join(",") || a.name || a.id,
        action: del,
        before: appView(a),
        after: null,
        reason: delReason(dup ? "a duplicate of the tunnel route's Access app" : "no droplet file has this tunnel route any more"),
        ...(hosts[0] && ownerOfName(hosts[0]) ? { droplet: ownerOfName(hosts[0])! } : {}),
        ids: { id: a.id },
      },
    });
  }
  for (const t of plan.staleTargets) {
    const f = flattenName(lc(t.hostname), zoneNames);
    add({
      phase: PHASE.targetDelete,
      role: "XT",
      ...(f.ok ? { chain: `ssh ${f.sshHostname}` } : {}),
      op: {
        kind: "infra-target",
        key: lc(t.hostname),
        action: del,
        before: targetView(t),
        after: null,
        reason: delReason(fileNames.has(lc(t.hostname)) ? "a duplicate SSH target" : "no droplet file has this droplet any more"),
        ...(ownerOfName(t.hostname) ? { droplet: ownerOfName(t.hostname)! } : {}),
        ids: { id: t.id },
      },
    });
  }

  // ---------- vpc-, healthcheck, infrastructure app (independent of the chains) ----------

  for (const v of plan.vpc) {
    if (v.op === "noop") {
      unchanged++;
      continue;
    }
    add(
      {
        phase: PHASE.vpc,
        role: "free",
        op: {
          kind: "dns-record",
          key: `A ${v.vpcName}`,
          action: opAction(v.op),
          before: v.existing ? dnsView(v.existing) : null,
          after: j(v.body),
          reason: v.op === "create" ? "private name for server-to-server traffic in the region" : "the droplet's private IP changed",
          droplet: v.name,
          ids: { zone: v.zoneId, ...(v.existingId ? { id: v.existingId } : {}) },
        },
      },
      v.pending,
    );
  }
  for (const { zoneId, record } of plan.staleVpcDns) {
    const name = lc(record.name);
    add({
      phase: PHASE.vpcDelete,
      role: "free",
      op: {
        kind: "dns-record",
        key: `${record.type} ${name}`,
        action: del,
        before: dnsView(record),
        after: null,
        reason: delReason(plan.vpc.some((v) => v.vpcName === name) ? "a duplicate of the tool's own record" : "no droplet file has this private name any more"),
        ...(ownerOfName(name) ? { droplet: ownerOfName(name)! } : {}),
        ids: { zone: zoneId, id: record.id },
      },
    });
  }
  for (const h of plan.health) {
    if (h.op === "noop") {
      unchanged++;
      continue;
    }
    add(
      {
        phase: PHASE.health,
        role: "free",
        op: {
          kind: "access-app",
          key: h.domain,
          action: opAction(h.op),
          before: h.existing ? appView(h.existing) : null,
          after: j(h.body),
          reason: "public /healthcheck bypass for a deploy target",
          droplet: h.name,
          ...(h.existingId ? { ids: { id: h.existingId } } : {}),
        },
      },
      h.pending,
    );
  }
  for (const a of plan.staleHealthApps) {
    const d = appDestinations(a)[0] ?? "";
    add({
      phase: PHASE.healthDelete,
      role: "free",
      op: {
        kind: "access-app",
        key: appDestinations(a).join(",") || a.name || a.id,
        action: del,
        before: appView(a),
        after: null,
        reason: delReason("the droplet is no longer a deploy target, or a duplicate bypass"),
        ...(ownerOfName(d.split("/")[0]!) ? { droplet: ownerOfName(d.split("/")[0]!)! } : {}),
        ids: { id: a.id },
      },
    });
  }
  const ia = plan.infraApp;
  if (ia.op === "noop") unchanged++;
  else
    add({
      phase: PHASE.infraApp,
      role: "free",
      op: {
        kind: "infra-app",
        key: ia.body.name,
        action: opAction(ia.op),
        before: ia.existing ? appView(ia.existing) : null,
        after: j(ia.body),
        reason: ia.op === "create" ? "the one infrastructure app covering every SSH target" : "the SSH admins changed",
        ...(ia.existingId ? { ids: { id: ia.existingId } } : {}),
      },
    });

  return { ops: finish(drafts), unchanged };
}

function groupRules(h: string, t: UpsertTarget): IngressRule[] {
  const m = mergeIngress({ ingress: [] }, { upserts: new Map([[h, t]]), removes: new Set(), owned: new Set(), ownedWeb: new Set() });
  return (m.config.ingress ?? []).filter((r) => lc(r.hostname) === h);
}

function routeReason(h: string, chain: string): string {
  if (chain.startsWith("ssh ")) return `SSH route ${h} in the region's tunnel`;
  if (chain.startsWith("route ")) return `tunnel route ${h} (allow.tunnel)`;
  return `site route ${h} in the region's tunnel`;
}

/** ids.failRemove: the owned route group for `hostname` in `tunnelId`, if there is one. */
function failRemove(snap: Snapshot, tunnelId: string, hostname: string): Record<string, string> {
  const tc = snap.tunnels[tunnelId] as TunnelConfiguration | ReadError | undefined;
  if (!tc || isErr(tc)) return {};
  const rules = rulesFor(tc.config, hostname);
  return rules.length ? { failRemove: JSON.stringify({ tunnel: tunnelId, hostname, rules }) } : {};
}

/** Unique keys, the deps of every op, its phase; sorted in apply order. */
function finish(drafts: Draft[]): PlanOp[] {
  // Keys must be unique per kind: a duplicate (a second record or app the tool owns for the same
  // name) gets its id appended.
  const seen = new Map<string, number>();
  for (const d of drafts) seen.set(`${d.op.kind} ${d.op.key}`, (seen.get(`${d.op.kind} ${d.op.key}`) ?? 0) + 1);
  for (const d of drafts) {
    if ((seen.get(`${d.op.kind} ${d.op.key}`) ?? 0) > 1 && (d.op.action === "delete" || d.op.action === "report") && d.op.ids?.id) {
      d.op.key = `${d.op.key} (duplicate ${d.op.ids.id})`;
    }
  }
  const ref = (d: Draft) => `${d.op.kind} ${d.op.key}`;
  const inChain = (chain: string | undefined, roles: Role[]) => drafts.filter((x) => chain && x.chain === chain && roles.includes(x.role));
  for (const d of drafts) {
    let deps: Draft[] = [];
    switch (d.role) {
      case "A":
        deps = inChain(d.chain, ["T"]);
        break;
      case "I":
        deps = d.op.action === "report" ? [] : inChain(d.chain, ["T", "A", "G"]);
        break;
      case "D":
      case "M":
        deps = inChain(d.chain, ["T", "A", "G", "I"]);
        break;
      case "XI":
        deps = inChain(d.chain, ["XD"]);
        break;
      case "XA":
        deps = d.dupExempt ? [] : (d.chains ?? []).flatMap((c) => inChain(c, ["XD", "XI"]));
        break;
      case "XW":
        deps = d.exception ? [] : inChain(d.chain, d.notFound ? ["G", "I"] : ["G"]);
        break;
      case "XT":
        deps = d.chain ? inChain(d.chain, ["XD", "XI", "XA"]) : drafts.filter((x) => ["XD", "XI", "XA"].includes(x.role) && (x.chain ?? x.chains?.[0] ?? "").startsWith("ssh "));
        if (d.chain) deps.push(...drafts.filter((x) => x.role === "XA" && x.chains?.includes(d.chain!)));
        break;
      default:
        deps = [];
    }
    const refs = [...new Set(deps.filter((x) => x !== d && x.op.action !== "report").map(ref))];
    d.op.ids = { ...(d.op.ids ?? {}), phase: String(d.phase), ...(refs.length ? { deps: JSON.stringify(refs) } : {}) };
  }
  return drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.phase - b.d.phase || a.i - b.i)
    .map(({ d }) => d.op);
}
