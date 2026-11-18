// Pure planning, ported from the infra-sync Worker (src/plan.ts there): buildPlan + planWeb.
//
// The input changes from DigitalOcean tags + web-config.json to the desired state built from the
// droplet files (adaptDroplets below). Everything after the adapter follows the Worker step by
// step, so that a plan against what the Worker built shows no change (phase D). New here:
// allow.tunnel routes (planRoutes) and exceptions with service tokens (bodies.ts).

import {
  CI_DEPLOY_TAG,
  DEFAULT_PROTECTED_PATHS,
  DNS_COMMENT_MARKER,
  HEALTH_BYPASS_PATH,
  KNOWN_AFTER_CREATE,
  NAME_PREFIX,
  RESERVED_PREFIXES,
  TARGET_TAG_KEY,
  TARGET_TAG_VALUE,
  WEB_ADMIN_APP_PREFIX,
  WEB_APP_PREFIX,
  WEB_PUBLIC_TAG,
  WEB_STAFF_TAG,
} from "../core/constants.js";
import type { DesiredDroplet, DesiredState } from "../core/desired.js";
import type { AccountConfig, EnvName, WebException, WebSpec, Who } from "../core/model.js";
import { flattenName } from "../core/naming.js";
import { normPath } from "../core/values.js";
import {
  type AppBody,
  appBody,
  appDestinations,
  appDomains,
  type DnsBody,
  dnsBody,
  healthAppBody,
  type InfraAppBody,
  infraAppBody,
  isInfraApp,
  isLink,
  isOwnedApp,
  isOwnedDns,
  isOwnedHealthApp,
  isOwnedRouteApp,
  isOwnedTarget,
  isOwnedVpcDns,
  isOwnedWebApp,
  isOwnedWebDns,
  isReservedName,
  lc,
  normCriteria,
  normPolicies,
  routeAppBody,
  sameWebApp,
  type TargetBody,
  targetBody,
  type VpcBody,
  vpcBody,
  type WebAppBody,
  type WebAppKind,
  webAdminAppBody,
  webAppKind,
  webExceptionAppBody,
  webIngress,
  webSiteAppBody,
  withPolicyIds,
} from "./bodies.js";
import { findDependents, type SiteHosts } from "./dependents.js";
import { type IngressTarget, isOwnedRule, NOT_FOUND_SERVICE, ownedHostnamesIn } from "./ingress.js";
import type { AccessApp, CloudflareObserved, Dependent, DnsRecord, InfraTarget, ReadError, TunnelConfiguration, Zone } from "./types.js";

// ---------- inputs ----------

/** The Worker's Snapshot without the droplets (which come from the desired state). */
export interface Snapshot {
  zones: Zone[];
  targets: InfraTarget[];
  apps: AccessApp[];
  tunnels: Record<string, TunnelConfiguration | ReadError>;
  /** By zone id: records whose name starts with ssh- (the Worker read them with name.startswith=ssh-). */
  dns: Record<string, DnsRecord[] | ReadError>;
  /** By zone id: records whose name starts with vpc-. */
  vpcDns: Record<string, DnsRecord[] | ReadError>;
  /** By zone id: every record (site hostnames, dependents). */
  zoneDns: Record<string, DnsRecord[] | ReadError>;
}

/** The Worker's SyncConfig, from account.yaml. */
export interface Cfg {
  /** Lowercase, deduplicated, sorted (the Worker's parseEmails). */
  adminEmails: string[];
  /** Service token ids per environment, deduplicated and sorted (the Worker's CI_SERVICE_TOKEN_IDS). */
  ciTokens: Record<EnvName, string[]>;
  /** Lowercase. */
  staffPolicyId: string;
  maxDeletes: number;
  maxDeleteFraction: number;
  /** name -> token id */
  serviceTokens: Record<string, string>;
  tunnelsByRegion: Record<string, string>;
}

/** A droplet as the planner sees it (the Worker's Droplet, built from a droplet file). */
export interface Drop {
  name: string;
  region: string;
  /** KNOWN_AFTER_CREATE for a droplet the tool is about to create. */
  privateIp?: string;
  /** Managed tags from the file (env-*, ci-deploy, web-*). Empty for a droplet with no file. */
  tags: string[];
  publicIps: string[];
  /** Its site config (droplet file `web:`), the Worker's web-config.json entry. */
  site?: WebSpec;
  /** Undefined for a droplet with no file: reported by the engine, held here. */
  dd?: DesiredDroplet;
  /** Planned and its ops are pending (status create). */
  pending: boolean;
}

// ---------- plan types ----------

export type Op = "create" | "update" | "noop";

export interface VpcPlan {
  name: string;
  vpcName: string;
  zoneId: string;
  op: Op;
  existingId?: string;
  existing?: DnsRecord;
  body: VpcBody;
  pending: boolean;
}

export interface HealthPlan {
  name: string;
  domain: string;
  op: Op;
  existingId?: string;
  existing?: AccessApp;
  body: AppBody;
  pending: boolean;
}

export interface WebAppPlan {
  kind: WebAppKind;
  /** host/path, lowercase, no trailing slash (appDestinations form) */
  destination: string;
  /** the route goes up only when every gating app is in place */
  gating: boolean;
  op: Op;
  existingId?: string;
  existingKind?: WebAppKind;
  existing?: AccessApp;
  body: WebAppBody;
}

export interface WebSitePlan {
  name: string;
  hostname: string;
  zone: string;
  zoneId: string;
  tunnelId: string;
  tag: typeof WEB_STAFF_TAG | typeof WEB_PUBLIC_TAG;
  /** The route. For an extra hostname of a public site it carries notFoundPaths. */
  ingress: IngressTarget;
  apps: WebAppPlan[];
  /** undefined while another record holds the name (awaiting cutover), and for implicit hostnames */
  dns?: { op: Op; existingId?: string; existing?: DnsRecord; body: DnsBody };
  /** an "infra-sync: web H" (whole-host, staff) app existed before this run */
  hasHostApp: boolean;
  source: "base" | "declared" | "implicit";
  healthPath: string;
  pending: boolean;
}

export interface HostPlan {
  name: string;
  privateIp: string;
  region: string;
  tunnelId: string;
  zone: string;
  zoneId: string;
  sshHostname: string;
  env?: EnvName;
  target: { op: Op; existingId?: string; existing?: InfraTarget; body: TargetBody };
  /** Set when something on the ssh- hostname belongs to someone else or cannot be read: then only the target is managed. */
  hostnameBlocked?: string;
  app?: { op: Op; existingId?: string; existing?: AccessApp; body: AppBody };
  ingressService: string;
  dns?: { op: Op; existingId?: string; existing?: DnsRecord; body: DnsBody };
  pending: boolean;
}

/** An allow.tunnel route (new in this tool). */
export interface RoutePlan {
  name: string;
  hostname: string;
  zoneId: string;
  tunnelId: string;
  ingressService: string;
  app: { op: Op; existingId?: string; existing?: AccessApp; body: WebAppBody };
  dns: { op: Op; existingId?: string; existing?: DnsRecord; body: DnsBody };
  pending: boolean;
}

/** A route the plan shows but does not build (UDP, port ranges). */
export interface RouteReport {
  name: string;
  hostname: string;
  port: string;
  who: Who[];
  reason: string;
}

export interface StaleIngress {
  tunnelId: string;
  hostname: string;
  reason: "gone" | "moved";
}

export interface Diag {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  droplet?: string;
}

export interface Plan {
  hosts: HostPlan[];
  /** domains of the tool's ssh- apps + names of marked ssh- DNS records */
  ownedHostnames: Set<string>;
  staleDns: Array<{ zoneId: string; record: DnsRecord }>;
  staleIngress: StaleIngress[];
  staleApps: AccessApp[];
  staleTargets: InfraTarget[];
  vpc: VpcPlan[];
  staleVpcDns: Array<{ zoneId: string; record: DnsRecord }>;
  health: HealthPlan[];
  staleHealthApps: AccessApp[];
  web: WebSitePlan[];
  /** site hosts of "infra-sync: web..." apps + names of marked site CNAMEs + declared hostnames */
  ownedWebHostnames: Set<string>;
  staleWebDns: Array<{ zoneId: string; record: DnsRecord }>;
  staleWebIngress: StaleIngress[];
  staleWebApps: AccessApp[];
  routes: RoutePlan[];
  routeReports: RouteReport[];
  ownedRouteHostnames: Set<string>;
  staleRouteDns: Array<{ zoneId: string; record: DnsRecord }>;
  staleRouteIngress: StaleIngress[];
  staleRouteApps: AccessApp[];
  deletionsAllowed: boolean;
  deletionBlockReason?: string;
  deleteCount: number;
  ownedCount: number;
  infraApp: { op: Op; existingId?: string; existing?: AccessApp; body: InfraAppBody };
  diagnostics: Diag[];
  dependents: Dependent[];
  readErrors: boolean;
  /** Droplet name a site hostname belongs to (from the droplet files), or the hostname itself. */
  ownerOf: (h: string) => string;
}

// ---------- adapter: account.yaml + droplet files -> the Worker's inputs ----------

const isErr = <T>(x: T | ReadError | undefined): x is ReadError => !!x && typeof x === "object" && "error" in x;

export function snapshotFrom(observed: CloudflareObserved): Snapshot {
  const dns: Snapshot["dns"] = {};
  const vpcDns: Snapshot["vpcDns"] = {};
  const zoneDns: Snapshot["zoneDns"] = {};
  for (const z of observed.zones) {
    const recs = observed.dns[z.id] ?? { error: "not read" };
    if (isErr(recs)) {
      dns[z.id] = recs;
      vpcDns[z.id] = recs;
      zoneDns[z.id] = recs;
      continue;
    }
    // The Worker listed these with name.startswith=ssh- / vpc-.
    dns[z.id] = recs.filter((r) => r.name.startsWith("ssh-"));
    vpcDns[z.id] = recs.filter((r) => r.name.startsWith("vpc-"));
    zoneDns[z.id] = recs;
  }
  return { zones: observed.zones, targets: observed.targets, apps: observed.apps, tunnels: observed.tunnels, dns, vpcDns, zoneDns };
}

export function cfgFrom(account: AccountConfig): Cfg {
  const cf = account.cloudflare;
  const ids = (names: readonly string[] | undefined) => [...new Set((names ?? []).flatMap((n) => (cf.service_tokens[n] ? [cf.service_tokens[n]!] : [])))].sort();
  return {
    adminEmails: [...new Set(cf.ssh_admin_emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].sort(),
    ciTokens: { prod: ids(cf.ci_deploy_tokens.prod), staging: ids(cf.ci_deploy_tokens.staging), internal: ids(cf.ci_deploy_tokens.internal) },
    staffPolicyId: cf.staff_policy_id.trim().toLowerCase(),
    maxDeletes: cf.guards.max_deletes,
    maxDeleteFraction: cf.guards.max_delete_fraction,
    serviceTokens: { ...cf.service_tokens },
    tunnelsByRegion: { ...cf.tunnels },
  };
}

/** Every droplet the planner knows: the droplet files, then the droplets that have no file. */
export function adaptDroplets(desired: DesiredState): Drop[] {
  const out: Drop[] = desired.droplets.map((dd) => ({
    name: dd.name,
    region: dd.region ?? "",
    ...(dd.status === "create" ? { privateIp: KNOWN_AFTER_CREATE } : dd.privateIpv4 ? { privateIp: dd.privateIpv4 } : {}),
    tags: dd.tags,
    publicIps: [dd.observed?.publicIpv4, dd.observed?.publicIpv6].filter((x): x is string => !!x),
    ...(dd.spec.web ? { site: dd.spec.web } : {}),
    dd,
    pending: dd.status === "create",
  }));
  for (const u of desired.unmanaged) {
    out.push({ name: u.name, region: u.region, ...(u.privateIpv4 ? { privateIp: u.privateIpv4 } : {}), tags: [], publicIps: [], pending: false });
  }
  return out;
}

// ---------- planning ----------

const ENV_BY_TAG: Record<string, EnvName> = { "env-prod": "prod", "env-staging": "staging", "env-internal": "internal" };

export function buildPlan(snap: Snapshot, cfg: Cfg, drops: Drop[]): Plan {
  const diagnostics: Diag[] = [];
  const diag = (level: Diag["level"], code: string, message: string, droplet?: string) =>
    diagnostics.push({ level, code, message, ...(droplet ? { droplet } : {}) });
  // The Worker's lists, by the severity they get here (README: Worker errors that are reads or
  // breaking dependents -> error; conflicts, skipped, warnings -> warning).
  const skipped = (name: string, reason: string) => diag("warning", "cloudflare-skipped", `${name}: ${reason}`, name);
  const conflict = (name: string, reason: string) => diag("warning", "cloudflare-conflict", `${name}: ${reason}`, name);
  const warn = (message: string, droplet?: string) => diag("warning", "cloudflare-warning", message, droplet);
  const readError = (message: string) => diag("error", "cloudflare-read-error", message);

  const zoneNames = snap.zones.map((z) => lc(z.name));
  const zoneIdByName = new Map(snap.zones.map((z) => [lc(z.name), z.id]));

  // Hostnames/names that must not be deleted even though they are not managed this run.
  const heldHostnames = new Set<string>();
  const heldNames = new Set<string>();
  const heldVpcNames = new Set<string>();
  const hold = (name: string) => {
    heldNames.add(name);
    const f = flattenName(name, zoneNames);
    if (f.ok) {
      heldHostnames.add(f.sshHostname);
      heldVpcNames.add(f.vpcHostname);
    }
  };

  // 1. Droplets -> candidate hosts
  type Cand = {
    name: string;
    privateIp: string;
    region: string;
    tunnelId: string;
    zone: string;
    zoneId: string;
    sshHostname: string;
    vpcHostname: string;
    env?: EnvName;
    tokenIds: string[];
    ciDeploy: boolean;
    tags: string[];
    drop: Drop;
    pending: boolean;
  };
  const cands: Cand[] = [];
  for (const d of drops) {
    // New: a droplet with no file is left alone, and so is a file whose droplet can't be managed
    // (missing, several droplets with its name). Their objects are kept, never changed.
    if (!d.dd || d.dd.status === "missing" || d.dd.status === "conflict") {
      hold(d.name);
      continue;
    }
    const f = flattenName(d.name, zoneNames);
    if (!f.ok) {
      skipped(d.name, f.reason);
      heldNames.add(d.name);
      continue;
    }
    const region = d.region;
    const tunnelId = cfg.tunnelsByRegion[region];
    if (!tunnelId) {
      skipped(d.name, `region "${region}" has no tunnel in account.cloudflare.tunnels`);
      continue;
    }
    const ip = d.privateIp;
    if (!ip) {
      skipped(d.name, "no private IPv4 yet (networks.v4[type=private])");
      heldNames.add(d.name);
      heldHostnames.add(f.sshHostname);
      heldVpcNames.add(f.vpcHostname);
      continue;
    }
    const tags = d.tags;
    const envs = [...new Set(tags.filter((t) => t in ENV_BY_TAG).map((t) => ENV_BY_TAG[t]!))];
    const env = envs.length === 1 ? envs[0] : undefined;
    if (envs.length > 1) warn(`${d.name}: several env-* tags (${envs.join(", ")})`, d.name);
    let tokenIds: string[] = [];
    if (tags.includes(CI_DEPLOY_TAG)) {
      if (!env) {
        warn(`${d.name}: deploy: true but no env; no CI service-token policy added`, d.name);
      } else if (!cfg.ciTokens[env].length) {
        warn(`${d.name}: deploy: true (${env}) but account.cloudflare.ci_deploy_tokens.${env} is empty; no CI service-token policy added`, d.name);
      } else {
        tokenIds = cfg.ciTokens[env];
      }
    }
    cands.push({
      name: d.name,
      privateIp: ip,
      region,
      tunnelId,
      zone: f.zone,
      zoneId: zoneIdByName.get(f.zone)!,
      sshHostname: f.sshHostname,
      vpcHostname: f.vpcHostname,
      ...(env ? { env } : {}),
      tokenIds,
      ciDeploy: tags.includes(CI_DEPLOY_TAG),
      tags,
      drop: d,
      pending: d.pending,
    });
  }

  // 2. Duplicates (same droplet name, or two names flattening to one hostname): manage neither.
  const countBy = (k: (c: Cand) => string) => {
    const m = new Map<string, number>();
    for (const c of cands) m.set(k(c), (m.get(k(c)) ?? 0) + 1);
    return m;
  };
  const nameCount = countBy((c) => c.name);
  const hostCount = countBy((c) => c.sshHostname);
  const unique: Cand[] = [];
  for (const c of cands) {
    if ((nameCount.get(c.name) ?? 0) > 1 || (hostCount.get(c.sshHostname) ?? 0) > 1) {
      conflict(c.name, `another droplet has the same name or flattens to ${c.sshHostname}`);
      heldNames.add(c.name);
      heldHostnames.add(c.sshHostname);
      heldVpcNames.add(c.vpcHostname);
      continue;
    }
    unique.push(c);
  }

  // 3. Index current Cloudflare state
  const ownedApps = snap.apps.filter(isOwnedApp);
  const ownedHostnames = new Set<string>();
  const ownedAppByHost = new Map<string, AccessApp[]>();
  for (const a of ownedApps) {
    for (const h of appDomains(a)) {
      ownedHostnames.add(h);
      ownedAppByHost.set(h, [...(ownedAppByHost.get(h) ?? []), a]);
    }
  }
  const foreignAppHosts = new Map<string, string>();
  for (const a of snap.apps) {
    if (isOwnedApp(a) || isInfraApp(a)) continue;
    for (const h of appDomains(a)) foreignAppHosts.set(h, a.name ?? a.id);
  }

  const ownedTargets = snap.targets.filter(isOwnedTarget);
  const foreignTargets = snap.targets.filter((t) => !isOwnedTarget(t));
  const ownedTargetsByName = new Map<string, InfraTarget[]>();
  for (const t of ownedTargets) {
    const k = lc(t.hostname);
    ownedTargetsByName.set(k, [...(ownedTargetsByName.get(k) ?? []), t]);
  }

  const tunnelErrors = new Map<string, string>();
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) tunnelErrors.set(tid, tc.error);
    else if (tc.source !== "cloudflare") tunnelErrors.set(tid, `tunnel ${tid} is not remotely managed (source=${tc.source})`);
  }
  for (const [tid, e] of tunnelErrors) readError(`tunnel ${tid}: ${e}`);

  const dnsErrors = new Map<string, string>();
  const dnsByName = new Map<string, Array<{ zoneId: string; record: DnsRecord }>>();
  for (const [zid, recs] of Object.entries(snap.dns)) {
    if (isErr(recs)) {
      dnsErrors.set(zid, recs.error);
      readError(`dns zone ${zid}: ${recs.error}`);
      continue;
    }
    for (const r of recs) {
      const k = lc(r.name);
      dnsByName.set(k, [...(dnsByName.get(k) ?? []), { zoneId: zid, record: r }]);
    }
  }

  // A DNS record carrying the marker is a second proof of ownership: the tool creates the CNAME
  // only after its ingress rule and deletes it before the rule. This lets a run repair a route whose
  // Access app was deleted out-of-band instead of calling it foreign.
  const appOwnedHostnames = new Set(ownedHostnames);
  for (const [name, list] of dnsByName) {
    if (name.startsWith("ssh-") && list.some((x) => isOwnedDns(x.record))) ownedHostnames.add(name);
  }

  // Foreign ingress rules by hostname (in any configured tunnel).
  const foreignIngress = new Map<string, string>();
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const r of tc.config?.ingress ?? []) {
      const h = lc(r.hostname);
      if (h && !(h.startsWith("ssh-") && ownedHostnames.has(h))) foreignIngress.set(h, tid);
    }
  }

  // Routes the tool owns that have lost their Access app: unprotected until repaired. A warning,
  // not an error: an error would block the very apply that repairs it.
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const h of ownedHostnamesIn(tc.config, ownedHostnames)) {
      if (!appOwnedHostnames.has(h)) {
        diag("warning", "cloudflare-repair", `tunnel ${tid}: route ${h} has no "${NAME_PREFIX}" Access app (deleted out-of-band?); recreating it, or removing the route if that fails`);
      }
    }
  }

  const claimedTargetIds = new Set<string>(); // owned targets matched to a droplet this run (by name or, after a rename, by IP)
  // 4. Per-host plan
  const hosts: HostPlan[] = [];
  for (const c of unique) {
    const nameKey = lc(c.name);
    // Target conflicts: a target the tool does not own with the same hostname or IP.
    const clash = foreignTargets.find((t) => lc(t.hostname) === nameKey || (!c.pending && t.ip?.ipv4?.ip_addr === c.privateIp));
    if (clash) {
      conflict(
        c.name,
        `infrastructure target ${clash.id} (${clash.hostname}, ${clash.ip?.ipv4?.ip_addr}) is not managed by the tool; tag it ${TARGET_TAG_KEY}=${TARGET_TAG_VALUE} to adopt it or delete it`,
      );
      heldNames.add(c.name);
      heldHostnames.add(c.sshHostname);
      continue;
    }
    const tBody = targetBody(c.name, c.privateIp);
    // A renamed droplet keeps its private IP: update its target in place (a second target with the
    // same IP is refused by the API), unless a droplet with the old name still exists.
    const existingT =
      ownedTargetsByName.get(nameKey)?.[0] ??
      (c.pending
        ? undefined
        : ownedTargets.find(
            (t) => t.ip?.ipv4?.ip_addr === c.privateIp && !unique.some((u) => lc(u.name) === lc(t.hostname)) && !heldNames.has(t.hostname),
          ));
    if (existingT) claimedTargetIds.add(existingT.id);
    const target: HostPlan["target"] = !existingT
      ? { op: "create", body: tBody }
      : existingT.ip?.ipv4?.ip_addr !== c.privateIp || existingT.hostname !== c.name
        ? { op: "update", existingId: existingT.id, existing: existingT, body: tBody }
        : { op: "noop", existingId: existingT.id, existing: existingT, body: tBody };

    const hp: HostPlan = {
      name: c.name,
      privateIp: c.privateIp,
      region: c.region,
      tunnelId: c.tunnelId,
      zone: c.zone,
      zoneId: c.zoneId,
      sshHostname: c.sshHostname,
      ...(c.env ? { env: c.env } : {}),
      target,
      ingressService: `ssh://${c.privateIp}:22`,
      pending: c.pending,
    };

    // Hostname-level conflicts (fail closed: no app/route/DNS for this droplet).
    const h = c.sshHostname;
    const reasons: string[] = [];
    if (foreignAppHosts.has(h)) reasons.push(`Access app "${foreignAppHosts.get(h)}" already covers ${h}`);
    if (foreignIngress.has(h)) reasons.push(`tunnel ${foreignIngress.get(h)} has an ingress rule for ${h} that the tool does not own`);
    const foreignDns = (dnsByName.get(h) ?? []).filter((x) => !isOwnedDns(x.record));
    if (foreignDns.length) {
      reasons.push(`DNS ${foreignDns.map((x) => `${x.record.type} ${x.record.name} -> ${x.record.content}`).join(", ")} has no "${DNS_COMMENT_MARKER}" comment; not overwritten`);
    }
    if (tunnelErrors.has(c.tunnelId)) reasons.push(`tunnel ${c.tunnelId} configuration unavailable`);
    if (dnsErrors.has(c.zoneId)) reasons.push(`DNS records of zone ${c.zone} unavailable`);
    if (reasons.length) {
      hp.hostnameBlocked = reasons.join("; ");
      const isConflict = foreignAppHosts.has(h) || foreignIngress.has(h) || foreignDns.length > 0;
      if (isConflict) conflict(c.name, hp.hostnameBlocked);
      else skipped(c.name, `hostname ${h} not managed this run: ${hp.hostnameBlocked}`);
      heldHostnames.add(h);
      hosts.push(hp);
      continue;
    }

    const aBody = appBody(h, cfg.adminEmails, c.tokenIds, c.env);
    const existingA = ownedAppByHost.get(h)?.[0];
    if (!existingA) hp.app = { op: "create", body: aBody };
    else {
      const same = existingA.name === aBody.name && lc(existingA.domain) === h && normPolicies(existingA.policies) === normPolicies(aBody.policies);
      hp.app = same
        ? { op: "noop", existingId: existingA.id, existing: existingA, body: aBody }
        : { op: "update", existingId: existingA.id, existing: existingA, body: { ...aBody, policies: withPolicyIds(aBody.policies, existingA.policies) } };
    }

    const dBody = dnsBody(h, c.tunnelId);
    const existingD = (dnsByName.get(h) ?? []).find((x) => isOwnedDns(x.record))?.record;
    if (!existingD) hp.dns = { op: "create", body: dBody };
    else {
      const same = existingD.type === "CNAME" && lc(existingD.content) === lc(dBody.content) && existingD.proxied === true;
      hp.dns = { op: same ? "noop" : "update", existingId: existingD.id, existing: existingD, body: dBody };
    }
    hosts.push(hp);
  }

  // 4b. vpc-<label>.<zone> records. Independent of tunnels, Access and targets: every droplet that
  // qualifies gets one, even when its ssh- hostname is blocked.
  const vpcErrors = new Set<string>();
  const vpcByName = new Map<string, Array<{ zoneId: string; record: DnsRecord }>>();
  for (const [zid, recs] of Object.entries(snap.vpcDns)) {
    if (isErr(recs)) {
      vpcErrors.add(zid);
      readError(`dns zone ${zid} (vpc- records): ${recs.error}`);
      continue;
    }
    for (const r of recs) {
      const k = lc(r.name);
      vpcByName.set(k, [...(vpcByName.get(k) ?? []), { zoneId: zid, record: r }]);
    }
  }
  const vpc: VpcPlan[] = [];
  for (const c of unique) {
    const vName = c.vpcHostname;
    if (vpcErrors.has(c.zoneId)) {
      heldVpcNames.add(vName);
      continue;
    }
    const existing = vpcByName.get(vName) ?? [];
    const foreign = existing.filter((x) => !isOwnedDns(x.record));
    if (foreign.length) {
      conflict(
        c.name,
        `DNS ${foreign.map((x) => `${x.record.type} ${x.record.name} -> ${x.record.content}`).join(", ")} has no "${DNS_COMMENT_MARKER}" comment; ${vName} not managed`,
      );
      heldVpcNames.add(vName);
      continue;
    }
    const body = vpcBody(vName, c.privateIp);
    const mine = existing.find((x) => isOwnedDns(x.record))?.record;
    const op: Op = !mine
      ? "create"
      : mine.type === "A" && mine.content === body.content && mine.proxied === false && mine.ttl === body.ttl
        ? "noop"
        : "update";
    vpc.push({ name: c.name, vpcName: vName, zoneId: c.zoneId, op, ...(mine ? { existingId: mine.id, existing: mine } : {}), body, pending: c.pending });
  }
  const wantedVpc = new Set(vpc.map((v) => v.vpcName));
  const staleVpcDns: Plan["staleVpcDns"] = [];
  for (const [name, list] of vpcByName) {
    const owned = list.filter((x) => isOwnedVpcDns(x.record));
    if (!owned.length) continue;
    if (wantedVpc.has(name)) staleVpcDns.push(...owned.slice(1)); // duplicates of our own record
    else if (!heldVpcNames.has(name)) staleVpcDns.push(...owned);
  }

  // 4c. Public /healthcheck for deploy targets. Independent of tunnels, targets and DNS.
  const ownedHealth = snap.apps.filter(isOwnedHealthApp);
  const ownedHealthByDomain = new Map<string, AccessApp[]>();
  for (const a of ownedHealth) {
    for (const d of appDestinations(a)) ownedHealthByDomain.set(d, [...(ownedHealthByDomain.get(d) ?? []), a]);
  }
  const foreignDestinations = new Map<string, string>();
  for (const a of snap.apps) {
    if (isOwnedHealthApp(a)) continue;
    for (const d of appDestinations(a)) foreignDestinations.set(d, a.name ?? a.id);
  }
  const health: HealthPlan[] = [];
  const heldHealth = new Set<string>(); // domains kept but not managed this run
  for (const n of heldNames) heldHealth.add(lc(`${n}/${HEALTH_BYPASS_PATH}`));
  for (const c of unique) {
    const domain = lc(`${c.name}/${HEALTH_BYPASS_PATH}`);
    if (!c.ciDeploy) continue;
    const foreign = foreignDestinations.get(domain);
    if (foreign) {
      warn(`${c.name}: Access app "${foreign}" already covers ${domain}; the healthcheck bypass is left to it`, c.name);
      continue;
    }
    const body = healthAppBody(c.name);
    const existing = ownedHealthByDomain.get(domain)?.[0];
    const op: Op = !existing
      ? "create"
      : existing.name === body.name && appDestinations(existing).join() === domain && normPolicies(existing.policies) === normPolicies(body.policies)
        ? "noop"
        : "update";
    health.push({
      name: c.name,
      domain,
      op,
      ...(existing ? { existingId: existing.id, existing } : {}),
      body: op === "update" ? { ...body, policies: withPolicyIds(body.policies, existing!.policies) } : body,
      pending: c.pending,
    });
  }
  const wantedHealth = new Set(health.map((h) => h.domain));
  const staleHealthApps: AccessApp[] = [];
  for (const a of ownedHealth) {
    const ds = appDestinations(a);
    const keep = ds.some((d) => wantedHealth.has(d) || heldHealth.has(d));
    const isDup = ds.length === 1 && wantedHealth.has(ds[0]!) && ownedHealthByDomain.get(ds[0]!)?.[0]?.id !== a.id;
    if (!keep || isDup) staleHealthApps.push(a);
  }

  // 4e (new). allow.tunnel routes. Planned before the sites so their hostnames stay out of the
  // sites' ownership and keep rules.
  const routes = planRoutes(snap, cfg, drops, unique, tunnelErrors, dnsErrorZonesOf(snap), { diag, conflict, skipped, warn });

  // 4d. Sites. Independent of targets and the ssh- chain; needs the region's tunnel and the private IP.
  const web = planWeb(
    snap,
    cfg,
    drops,
    unique.map((c) => ({ name: c.name, privateIp: c.privateIp, tunnelId: c.tunnelId, tags: c.tags, ciDeploy: c.ciDeploy, pending: c.pending })),
    tunnelErrors,
    routes.routeHosts,
    { diag, conflict, skipped, warn, readError },
  );

  // 5. Stale objects (owned, and no longer wanted)
  const wantedHost = new Map(hosts.filter((x) => !x.hostnameBlocked).map((x) => [x.sshHostname, x]));
  const keepHost = (h: string) => wantedHost.has(h) || heldHostnames.has(h) || hosts.some((x) => x.sshHostname === h);
  const keepName = (n: string) => heldNames.has(n) || hosts.some((x) => lc(x.name) === n);

  const staleDns: Plan["staleDns"] = [];
  for (const [name, list] of dnsByName) {
    const owned = list.filter((x) => isOwnedDns(x.record));
    if (!owned.length) continue;
    if (!keepHost(name)) staleDns.push(...owned);
    else if (wantedHost.has(name)) staleDns.push(...owned.slice(1)); // duplicates of our own record
  }

  const staleIngress: StaleIngress[] = [];
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const h of new Set(ownedHostnamesIn(tc.config, ownedHostnames))) {
      const w = wantedHost.get(h);
      if (w) {
        if (w.tunnelId !== tid) staleIngress.push({ tunnelId: tid, hostname: h, reason: "moved" });
      } else if (!keepHost(h)) {
        staleIngress.push({ tunnelId: tid, hostname: h, reason: "gone" });
      }
    }
  }

  const staleApps: AccessApp[] = [];
  for (const a of ownedApps) {
    const ds = appDomains(a);
    if (!ds.some(keepHost)) {
      staleApps.push(a);
      continue;
    }
    // Duplicate app for a wanted hostname (only the first one is managed).
    const isDuplicate = ds.length === 1 && wantedHost.has(ds[0]!) && ownedAppByHost.get(ds[0]!)?.[0]?.id !== a.id;
    if (isDuplicate) staleApps.push(a);
  }

  const staleTargets: InfraTarget[] = [];
  for (const [name, list] of ownedTargetsByName) {
    const unclaimed = (xs: InfraTarget[]) => xs.filter((t) => !claimedTargetIds.has(t.id));
    if (!keepName(name)) staleTargets.push(...unclaimed(list));
    else staleTargets.push(...unclaimed(list.slice(1))); // duplicates
  }

  // 6. Deletion safety
  const deleteCount =
    staleDns.length +
    staleIngress.length +
    staleApps.length +
    staleTargets.length +
    staleVpcDns.length +
    staleHealthApps.length +
    web.staleWebDns.length +
    web.staleWebIngress.length +
    web.staleWebApps.length +
    routes.staleRouteDns.length +
    routes.staleRouteIngress.length +
    routes.staleRouteApps.length;
  let ownedIngressCount = 0;
  for (const tc of Object.values(snap.tunnels)) {
    if (!isErr(tc)) ownedIngressCount += ownedHostnamesIn(tc.config, ownedHostnames).length;
  }
  let ownedDnsCount = 0;
  for (const list of dnsByName.values()) ownedDnsCount += list.filter((x) => isOwnedDns(x.record)).length;
  let ownedVpcCount = 0;
  for (const list of vpcByName.values()) ownedVpcCount += list.filter((x) => isOwnedVpcDns(x.record)).length;
  const ownedCount =
    ownedApps.length + ownedTargets.length + ownedIngressCount + ownedDnsCount + ownedVpcCount + ownedHealth.length + web.ownedCount + routes.ownedCount;

  // Which droplets the deletions belong to, keyed "<flattened label>.<zone>" so a droplet's ssh-,
  // vpc-, target, healthcheck and site objects share one key.
  const ownerKey = (name: string) => {
    const f = flattenName(lc(name), zoneNames);
    return f.ok ? `${f.label}.${f.zone}` : lc(name);
  };
  const generated = (h: string) => lc(h).replace(/^(ssh|vpc)-/, "");
  const deleteOwners = new Set<string>();
  for (const x of staleDns) deleteOwners.add(generated(x.record.name));
  for (const x of staleIngress) deleteOwners.add(generated(x.hostname));
  for (const a of staleApps) for (const d of appDomains(a)) deleteOwners.add(generated(d));
  for (const t of staleTargets) deleteOwners.add(ownerKey(t.hostname));
  for (const x of staleVpcDns) deleteOwners.add(generated(x.record.name));
  for (const a of staleHealthApps) for (const d of appDomains(a)) deleteOwners.add(ownerKey(d));
  for (const x of web.staleWebDns) deleteOwners.add(ownerKey(web.ownerOf(x.record.name)));
  for (const x of web.staleWebIngress) deleteOwners.add(ownerKey(web.ownerOf(x.hostname)));
  for (const a of web.staleWebApps) for (const d of appDomains(a)) deleteOwners.add(ownerKey(web.ownerOf(d)));
  for (const x of routes.staleRouteDns) deleteOwners.add(`route ${lc(x.record.name)}`);
  for (const x of routes.staleRouteIngress) deleteOwners.add(`route ${x.hostname}`);
  for (const a of routes.staleRouteApps) for (const d of appDomains(a)) deleteOwners.add(`route ${d}`);

  let deletionBlockReason: string | undefined;
  if (tunnelErrors.size || dnsErrors.size || vpcErrors.size || web.dnsErrorZones.size) {
    deletionBlockReason = "a tunnel configuration or DNS zone could not be read; no deletions this run";
  } else if (deleteCount > 0) {
    const fraction = ownedCount ? deleteCount / ownedCount : 1;
    if (deleteCount > cfg.maxDeletes) {
      deletionBlockReason = `refusing to delete ${deleteCount} objects (> guards.max_deletes=${cfg.maxDeletes}); raise account.cloudflare.guards in its own pull request if this is intended`;
    } else if (deleteCount > 6 && deleteOwners.size > 1 && fraction > cfg.maxDeleteFraction) {
      // Deleting one droplet is always allowed (up to max_deletes), even in a small fleet:
      //  - > 6: a droplet without a site has at most 6 objects (ssh- DNS + ingress + app + target +
      //    vpc- DNS + healthcheck app), so any 6 deletions pass;
      //  - deleteOwners.size > 1: a site droplet can have many more (per hostname: CNAME, route,
      //    one app per protected/exception path), so the fraction applies only when the deletions
      //    span more than one droplet.
      deletionBlockReason = `refusing to delete ${deleteCount} of ${ownedCount} managed objects (${Math.round(fraction * 100)}% > ${Math.round(cfg.maxDeleteFraction * 100)}%); raise account.cloudflare.guards in its own pull request if this is intended`;
    }
  }
  // The deletes become report ops; creates and updates still apply (as in the Worker). A read
  // failure is already an error above.
  if (deletionBlockReason && deleteCount > 0) diag("warning", "cloudflare-guard", deletionBlockReason);

  // 7. Infrastructure app
  const iBody = infraAppBody(cfg.adminEmails);
  const existingI = snap.apps.find(isInfraApp);
  const infraApp: Plan["infraApp"] = !existingI
    ? { op: "create", body: iBody }
    : normCriteria(existingI.target_criteria) === normCriteria(iBody.target_criteria) && normPolicies(existingI.policies) === normPolicies(iBody.policies)
      ? { op: "noop", existingId: existingI.id, existing: existingI, body: iBody }
      : { op: "update", existingId: existingI.id, existing: existingI, body: { ...iBody, policies: withPolicyIds(iBody.policies, existingI.policies) } };

  return {
    hosts,
    ownedHostnames,
    staleDns,
    staleIngress,
    staleApps,
    staleTargets,
    vpc,
    staleVpcDns,
    health,
    staleHealthApps,
    web: web.sites,
    ownedWebHostnames: web.ownedWebHostnames,
    staleWebDns: web.staleWebDns,
    staleWebIngress: web.staleWebIngress,
    staleWebApps: web.staleWebApps,
    routes: routes.routes,
    routeReports: routes.reports,
    ownedRouteHostnames: routes.ownedRouteHostnames,
    staleRouteDns: routes.staleRouteDns,
    staleRouteIngress: routes.staleRouteIngress,
    staleRouteApps: routes.staleRouteApps,
    deletionsAllowed: !deletionBlockReason,
    ...(deletionBlockReason ? { deletionBlockReason } : {}),
    dependents: web.dependents,
    readErrors: !!(tunnelErrors.size || dnsErrors.size || vpcErrors.size || web.dnsErrorZones.size),
    deleteCount,
    ownedCount,
    infraApp,
    diagnostics,
    ownerOf: web.ownerOf,
  };
}

function dnsErrorZonesOf(snap: Snapshot): Set<string> {
  return new Set(snap.zones.filter((z) => !snap.zoneDns[z.id] || isErr(snap.zoneDns[z.id])).map((z) => z.id));
}

// ---------- 4d. sites ----------

export interface WebCand {
  name: string;
  privateIp: string;
  tunnelId: string;
  tags: string[];
  ciDeploy: boolean;
  pending: boolean;
}

interface WebResult {
  sites: WebSitePlan[];
  ownedWebHostnames: Set<string>;
  staleWebDns: Array<{ zoneId: string; record: DnsRecord }>;
  staleWebIngress: StaleIngress[];
  staleWebApps: AccessApp[];
  ownedCount: number;
  dnsErrorZones: Set<string>;
  dependents: Dependent[];
  ownerOf: (h: string) => string;
}

interface Sink {
  diag: (level: Diag["level"], code: string, message: string, droplet?: string) => void;
  conflict: (name: string, reason: string) => void;
  skipped: (name: string, reason: string) => void;
  warn: (message: string, droplet?: string) => void;
}

const article = (type: string) => (/^[AEFHILMNORSX]/.test(type) ? "an" : "a");

function describeRecords(recs: DnsRecord[]): string {
  if (recs.length === 1) return `${article(recs[0]!.type)} ${recs[0]!.type} record`;
  return `${recs.length} records (${[...new Set(recs.map((r) => r.type))].join(", ")})`;
}

/**
 * `routeHosts`: allow.tunnel route hostnames (declared in a file, or carrying a tunnel-route app).
 * They belong to planRoutes: never a site's by marked DNS, never stale here.
 */
export function planWeb(
  snap: Snapshot,
  cfg: Cfg,
  drops: Drop[],
  cands: WebCand[],
  tunnelErrors: Map<string, string>,
  routeHosts: Set<string>,
  out: Sink & { readError: (message: string) => void },
): WebResult {
  const zoneNames = snap.zones.map((z) => lc(z.name));
  const zoneIdByName = new Map(snap.zones.map((z) => [lc(z.name), z.id]));
  const sitesCfg: Record<string, WebSpec> = {};
  for (const d of drops) if (d.site) sitesCfg[lc(d.name)] = d.site;
  const hostnamesOf = (n: string) => sitesCfg[n]?.hostnames ?? [];

  // Every record of every zone, by name. A zone that could not be read blocks its site hostnames
  // (we cannot prove a name is free) and all deletions.
  const dnsErrorZones = new Set<string>();
  const recsByName = new Map<string, Array<{ zoneId: string; record: DnsRecord }>>();
  for (const z of snap.zones) {
    const recs = snap.zoneDns[z.id];
    if (!recs || isErr(recs)) {
      dnsErrorZones.add(z.id);
      out.readError(`dns zone ${z.id} (site records): ${recs && isErr(recs) ? recs.error : "not read"}`);
      continue;
    }
    for (const r of recs) {
      const k = lc(r.name);
      recsByName.set(k, [...(recsByName.get(k) ?? []), { zoneId: z.id, record: r }]);
    }
  }

  // Apps: the tool's site apps by destination; every other app's destinations are foreign.
  const ownedApps = snap.apps.filter(isOwnedWebApp);
  const ownedByDest = new Map<string, AccessApp[]>();
  const ownedAppHosts = new Set<string>();
  for (const a of ownedApps) {
    for (const d of appDestinations(a)) ownedByDest.set(d, [...(ownedByDest.get(d) ?? []), a]);
    for (const h of appDomains(a)) if (!isReservedName(h)) ownedAppHosts.add(h);
  }
  const foreignDest = new Map<string, string>();
  for (const a of snap.apps) {
    if (isOwnedWebApp(a)) continue;
    for (const d of appDestinations(a)) foreignDest.set(d, a.name ?? a.id);
  }

  const ownerByHost = new Map<string, string>();
  for (const [name, s] of Object.entries(sitesCfg)) for (const h of s.hostnames) ownerByHost.set(lc(h), lc(name));
  const ownerOf = (h: string) => ownerByHost.get(lc(h)) ?? lc(h);
  const dropletNames = new Set(drops.map((d) => lc(d.name)));
  const tagsByName = new Map(drops.map((d) => [lc(d.name), d.tags]));
  const webTagOf = (tags: string[]) => {
    const t = [WEB_STAFF_TAG, WEB_PUBLIC_TAG].filter((x) => tags.includes(x));
    return t.length === 1 ? t[0] : undefined;
  };

  // Guard rail 1: names in any zone that point at a site ("dependents"). Worked out before ownership,
  // because an implicit extra hostname (a proxied CNAME to a site hostname) is owned by the same
  // declaration rule as a hostname listed in a droplet file, and needs a route before the site's cutover.
  const oneLevel = (h: string) => {
    const f = flattenName(h, zoneNames);
    return f.ok && !h.slice(0, h.length - f.zone.length - 1).includes(".");
  };
  const siteHosts: SiteHosts[] = [];
  for (const d of drops) {
    if (!webTagOf(d.tags)) continue;
    const n = lc(d.name);
    const hosts = [n, ...hostnamesOf(n).map(lc)].filter((h) => !isReservedName(h) && oneLevel(h));
    siteHosts.push({ site: n, hosts, publicIps: d.publicIps });
  }
  const allRecords = [...recsByName.values()].flat();
  const scan = findDependents(allRecords, siteHosts, zoneNames, dropletNames);
  for (const d of scan.dependents) {
    if (d.level === "error") out.diag("error", "cloudflare-dependent", `${d.site}: dependent ${d.detail}`, d.site);
    else if (d.level === "warning") out.diag("warning", "cloudflare-dependent", `${d.site}: dependent ${d.detail}`, d.site);
  }
  for (const w of scan.wildcardWarnings) out.diag("warning", "cloudflare-wildcard", w);
  const implicitBySite = new Map<string, string[]>();
  for (const d of scan.dependents) {
    if (d.kind !== "implicit") continue;
    implicitBySite.set(d.site, [...(implicitBySite.get(d.site) ?? []), d.name]);
    ownerByHost.set(d.name, d.site);
  }
  const implicitHosts = new Set([...implicitBySite.values()].flat());
  // Keep rule: a droplet that lost its web section keeps its implicit hostnames' objects too (like its
  // declared ones), so the same scan runs over every droplet, with a site or not, only to decide what is held.
  const heldImplicit = new Set<string>();
  const allHosts: SiteHosts[] = drops.map((d) => {
    const n = lc(d.name);
    return { site: n, hosts: [n, ...hostnamesOf(n).map(lc)].filter((h) => !isReservedName(h) && oneLevel(h)), publicIps: [] };
  });
  for (const d of findDependents(allRecords, allHosts, zoneNames, dropletNames).dependents) {
    if (d.kind !== "implicit") continue;
    heldImplicit.add(d.name);
    if (!ownerByHost.has(d.name)) ownerByHost.set(d.name, d.site);
  }

  // Ownership of site routes: an "infra-sync: web..." app or a marked site CNAME for that exact host.
  // (The healthcheck bypass app does NOT count: it sits on <droplet name>/healthcheck.)
  const ownedWebHostnames = new Set(ownedAppHosts);
  let ownedDnsCount = 0;
  for (const [name, list] of recsByName) {
    if (routeHosts.has(name)) continue; // an allow.tunnel route's CNAME (planRoutes)
    const n = list.filter((x) => isOwnedWebDns(x.record)).length;
    if (n) {
      ownedWebHostnames.add(name);
      ownedDnsCount += n;
    }
  }
  // Ownership by declaration: an extra hostname listed in a reviewed droplet file under a droplet with
  // a site is the tool's. Brand hostnames of public sites have no Access app, and no marked CNAME before
  // cutover, so nothing else could prove it. Never a droplet's own name (any droplet's), never ssh-/vpc-.
  const declaredHosts = new Set<string>();
  for (const [name, s] of Object.entries(sitesCfg)) {
    if (!dropletNames.has(lc(name)) || !webTagOf(tagsByName.get(lc(name)) ?? [])) continue;
    for (const raw of s.hostnames) {
      const h = lc(raw);
      if (!isReservedName(h) && !dropletNames.has(h)) declaredHosts.add(h);
    }
  }
  for (const h of implicitHosts) declaredHosts.add(h); // never a droplet name or ssh-/vpc- (checked in findDependents)
  for (const h of declaredHosts) ownedWebHostnames.add(h);

  const noSsh = new Set<string>();
  const foreignIngress = new Map<string, string>();
  const ownedRoutes = new Map<string, string[]>(); // host -> tunnels carrying an owned route (group)
  const notFoundRoutes = new Set<string>(); // `${tid} ${host}`: the host's rules include a 404 path rule
  let ownedRouteCount = 0;
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const r of tc.config?.ingress ?? []) {
      const h = lc(r.hostname);
      if (!h) continue;
      if (r.path && r.service === NOT_FOUND_SERVICE) notFoundRoutes.add(`${tid} ${h}`);
      if (isOwnedRule(r, noSsh, ownedWebHostnames)) {
        // A host's rules (404 path rules + main rule) are one route.
        if (!(ownedRoutes.get(h) ?? []).includes(tid)) {
          ownedRoutes.set(h, [...(ownedRoutes.get(h) ?? []), tid]);
          ownedRouteCount++;
        }
      } else if (!foreignIngress.has(h)) {
        foreignIngress.set(h, tid);
      }
    }
  }

  // 1. Which droplet claims which site hostname.
  type Claim = { cand: WebCand; tag: WebSitePlan["tag"]; zone: string; zoneId: string; site: WebSpec | undefined; source: WebSitePlan["source"] };
  const claims = new Map<string, Claim[]>();
  for (const c of cands) {
    const staff = c.tags.includes(WEB_STAFF_TAG);
    const pub = c.tags.includes(WEB_PUBLIC_TAG);
    if (!staff && !pub) continue;
    if (staff && pub) {
      out.warn(`${c.name}: both ${WEB_STAFF_TAG} and ${WEB_PUBLIC_TAG}; its site is treated as having none (nothing created, existing site objects kept)`, c.name);
      continue;
    }
    const site = sitesCfg[lc(c.name)];
    const declared = new Set((site?.hostnames ?? []).map(lc));
    for (const raw of [c.name, ...(site?.hostnames ?? []), ...(implicitBySite.get(lc(c.name)) ?? [])]) {
      const h = lc(raw);
      const source: WebSitePlan["source"] = h === lc(c.name) ? "base" : declared.has(h) ? "declared" : "implicit";
      if (isReservedName(h)) {
        out.warn(`${h}: site refused: names starting with ${RESERVED_PREFIXES.join(" or ")} are generated by the tool; nothing created for it`, c.name);
        continue;
      }
      const f = flattenName(h, zoneNames);
      if (!f.ok) {
        out.warn(`${h}: site refused: ${f.reason}; nothing created for it`, c.name);
        continue;
      }
      if (h.slice(0, h.length - f.zone.length - 1).includes(".")) {
        out.warn(
          `${h}: site refused: it is more than one level under ${f.zone}, and the free certificate only covers one level (*.${f.zone}); nothing created for it. Rename it to a one-level name such as ${f.label}.${f.zone}`,
          c.name,
        );
        continue;
      }
      const list = claims.get(h) ?? [];
      if (!list.some((x) => x.cand.name === c.name)) list.push({ cand: c, tag: staff ? WEB_STAFF_TAG : WEB_PUBLIC_TAG, zone: f.zone, zoneId: zoneIdByName.get(f.zone)!, site, source });
      claims.set(h, list);
    }
  }

  // 2. One plan per claimed hostname.
  const sites: WebSitePlan[] = [];
  const blockedHosts = new Set<string>(); // claimed but not managed this run: kept as they are
  for (const [h, list] of claims) {
    if (list.length > 1) {
      const names = list.map((x) => x.cand.name).join(", ");
      for (const x of list) out.conflict(x.cand.name, `site ${h} is claimed by several droplets (${names}); no site changes for it`);
      blockedHosts.add(h);
      continue;
    }
    const { cand: c, tag, zone, zoneId, site, source } = list[0]!;
    if (tunnelErrors.has(c.tunnelId) || dnsErrorZones.has(zoneId)) {
      const why = tunnelErrors.has(c.tunnelId) ? `tunnel ${c.tunnelId} configuration unavailable` : `DNS records of zone ${zone} unavailable`;
      out.skipped(c.name, `site ${h} not managed this run: ${why}`);
      blockedHosts.add(h);
      continue;
    }
    if (routeHosts.has(h)) {
      out.conflict(c.name, `site ${h} is also an allow.tunnel route; nothing created for it`);
      blockedHosts.add(h);
      continue;
    }

    // Path apps. <droplet name>/healthcheck of a deploy target belongs to the healthcheck bypass.
    const isBase = h === lc(c.name);
    const healthDest = c.ciDeploy && isBase ? lc(`${h}/${HEALTH_BYPASS_PATH}`) : undefined;
    type PathApp = { kind: "admin" | "exception"; path: string; dest: string; exc?: WebException };
    const pathApps: PathApp[] = [];
    // Public: the staff login on the droplet's own name; on extra hostnames the protected paths
    // answer 404 in the tunnel (rules in the same document as the route, so they need no gating app).
    const notFoundPaths: string[] = [];
    if (tag === WEB_PUBLIC_TAG) {
      for (const p of site?.protected_paths ?? DEFAULT_PROTECTED_PATHS) {
        if (isBase) pathApps.push({ kind: "admin", path: p, dest: h + normPath(p) });
        else notFoundPaths.push(p);
      }
    } else if (site?.protected_paths) {
      out.warn(`${h}: protected_paths only apply to public sites; ignored (the whole site needs the staff login)`, c.name);
    }
    for (const e of site?.exceptions ?? []) pathApps.push({ kind: "exception", path: e.path, dest: h + normPath(e.path), exc: e });
    const usable = pathApps.filter((x) => {
      if (x.dest !== healthDest) return true;
      out.warn(`${h}${x.path}: is the public healthcheck bypass of a deploy target; not used as ${x.kind === "admin" ? "a protected path" : "an exception"}`, c.name);
      return false;
    });

    // Fail closed: a route or gating Access app the tool does not own => nothing for this hostname.
    const reasons: string[] = [];
    if (foreignIngress.has(h)) reasons.push(`tunnel ${foreignIngress.get(h)} has an ingress rule for ${h} that the tool does not own`);
    const gating: Array<{ dest: string; name: string }> =
      tag === WEB_STAFF_TAG
        ? [{ dest: h, name: WEB_APP_PREFIX + h }]
        : usable.filter((x) => x.kind === "admin").map((x) => ({ dest: x.dest, name: `${WEB_ADMIN_APP_PREFIX}${h}${x.path}` }));
    for (const g of gating) {
      const f = foreignDest.get(g.dest);
      if (f) reasons.push(`Access app "${f}" already covers ${g.dest}; rename it to "${g.name}" to let the tool adopt it, or delete it`);
    }
    if (!gating.length && !notFoundPaths.length) {
      // e.g. public, whose only protected path is the healthcheck bypass: the route would have no login at all.
      out.warn(`${h}: public site has no usable protected path; nothing created for it`, c.name);
      blockedHosts.add(h);
      continue;
    }
    if (reasons.length) {
      out.conflict(c.name, `site ${h}: ${reasons.join("; ")}; nothing created for it`);
      blockedHosts.add(h);
      continue;
    }

    const apps: WebAppPlan[] = [];
    const addApp = (kind: WebAppKind, destination: string, body: WebAppBody, isGating: boolean) => {
      const existing = ownedByDest.get(destination)?.[0];
      const base = { kind, destination, gating: isGating };
      if (!existing) return apps.push({ ...base, op: "create", body });
      const existingKind = webAppKind(existing.name);
      const ek = existingKind ? { existingKind } : {};
      if (sameWebApp(existing, body, destination)) return apps.push({ ...base, op: "noop", existingId: existing.id, ...ek, existing, body });
      // Inline policies keep their app-scoped ids (matched by name); reusable ones are never carried over.
      const inlineExisting = (existing.policies ?? []).filter((p) => !p.reusable);
      const policies = body.policies.map((p) => (isLink(p) ? p : withPolicyIds([p], inlineExisting)[0]!));
      return apps.push({ ...base, op: "update", existingId: existing.id, ...ek, existing, body: { ...body, policies } });
    };
    // Exception apps first, then the gating apps. On a host that is already proxied the login applies
    // as soon as a gating app exists, so creating the exceptions first keeps webhooks and other machine
    // paths from getting the login in between.
    for (const x of usable) {
      if (x.kind !== "exception") continue;
      const f = foreignDest.get(x.dest);
      if (f) {
        out.warn(`${c.name}: Access app "${f}" already covers ${x.dest}; the exception is left to it`, c.name);
        continue;
      }
      const exc = x.exc!;
      const names = exc.allow === "everyone" ? [] : (exc.allow.service_tokens ?? []);
      const unknown = names.filter((n) => !cfg.serviceTokens[n]);
      if (unknown.length) {
        out.warn(`${h}${x.path}: service token ${unknown.join(", ")} is not in account.cloudflare.service_tokens; the exception is not built`, c.name);
        continue;
      }
      const tokenIds = [...new Set(names.map((n) => cfg.serviceTokens[n]!))].sort();
      addApp("exception", x.dest, webExceptionAppBody(h, exc, tokenIds), false);
    }
    if (tag === WEB_STAFF_TAG) addApp("site", h, webSiteAppBody(h, cfg.staffPolicyId), true);
    for (const x of usable) {
      if (x.kind === "admin") addApp("admin", x.dest, webAdminAppBody(h, x.path, cfg.staffPolicyId), true);
    }

    // DNS: create the CNAME only when nothing else holds the name (cutover).
    const recs = recsByName.get(h) ?? [];
    const mine = recs.find((x) => isOwnedWebDns(x.record))?.record;
    const foreign = recs.filter((x) => !isOwnedWebDns(x.record)).map((x) => x.record);
    const dBody = dnsBody(h, c.tunnelId);
    let dns: WebSitePlan["dns"];
    if (source === "implicit") {
      // Its own record is the CNAME to the site that made it a dependent: it stays as it is (no cutover).
    } else if (mine) {
      const same = mine.type === "CNAME" && lc(mine.content) === lc(dBody.content) && mine.proxied === true;
      dns = { op: same ? "noop" : "update", existingId: mine.id, existing: mine, body: dBody };
    } else if (foreign.length) {
      out.diag(
        "warning",
        "cloudflare-awaiting-cutover",
        `${h}: awaiting cutover (${describeRecords(foreign)} not managed by the tool still holds the name; the Worker's cutover.sh swaps it in place)`,
        c.name,
      );
    } else {
      dns = { op: "create", body: dBody };
    }

    // Health path: a warning when it sits under a protected path (the watch would only see the login).
    const healthPath = site?.health_path ?? (c.ciDeploy ? "/healthcheck/" : "/");
    const hp = normPath(healthPath);
    const under = (p: string) => hp === normPath(p) || hp.startsWith(normPath(p) + "/");
    if (tag === WEB_PUBLIC_TAG && isBase && (site?.protected_paths ?? DEFAULT_PROTECTED_PATHS).some(under)) {
      out.warn(`${c.name}: health_path ${healthPath} is under a protected path; a monitor only sees the staff login (302) or the 404 rule on extra hostnames`, c.name);
    }

    sites.push({
      name: c.name,
      hostname: h,
      zone,
      zoneId,
      tunnelId: c.tunnelId,
      tag,
      ingress: webIngress(site?.origin, c.privateIp, notFoundPaths),
      apps,
      ...(dns ? { dns } : {}),
      hasHostApp: (ownedByDest.get(h) ?? []).some((a) => webAppKind(a.name) === "site"),
      source,
      healthPath,
      pending: c.pending,
    });
  }

  // 3. Keep rule: every hostname of a droplet that still exists (with a site or not, managed or not).
  const wanted = new Map(sites.map((x) => [x.hostname, x]));
  const held = new Set<string>(blockedHosts);
  for (const d of drops) {
    const n = lc(d.name);
    held.add(n);
    for (const h of hostnamesOf(n)) held.add(lc(h));
  }
  for (const h of [...implicitHosts, ...heldImplicit]) held.add(h);
  const keepHost = (h: string) => wanted.has(h) || held.has(h);
  const ownedDnsNames = new Set([...recsByName].filter(([n, l]) => !routeHosts.has(n) && l.some((x) => isOwnedWebDns(x.record))).map(([n]) => n));
  for (const h of new Set([...ownedAppHosts, ...ownedDnsNames, ...ownedRoutes.keys()])) {
    if (wanted.has(h) || blockedHosts.has(h) || !held.has(h)) continue;
    const tags = tagsByName.get(ownerOf(h)) ?? tagsByName.get(h) ?? [];
    const webTags = [WEB_STAFF_TAG, WEB_PUBLIC_TAG].filter((t) => tags.includes(t));
    if (webTags.length === 1) continue; // has a site but not manageable right now: the reason is already reported
    out.warn(
      ownedDnsNames.has(h)
        ? `${h}: no web section but still on the tunnel; to roll back re-add its A record in place of the "${DNS_COMMENT_MARKER}" CNAME, then remove its tunnel route and "infra-sync: web..." Access apps by hand (or add the web section back)`
        : `${h}: no web section; its "infra-sync: web..." Access apps and tunnel route are kept while the droplet exists (the apps still apply if ${h} is proxied); remove them by hand if the site should leave Access`,
    );
  }

  // Routes that lost every site app (deleted out-of-band): unprotected until repaired. A warning:
  // an error would block the apply that repairs it.
  for (const [h, tids] of ownedRoutes) {
    if (ownedAppHosts.has(h)) continue;
    if (wanted.get(h)?.ingress.notFoundPaths?.length) continue;
    const next = wanted.has(h)
      ? "recreating its Access apps, or removing the route if that fails"
      : held.has(h)
        ? "nothing recreates them while the droplet has no web section; add it back or remove the route by hand"
        : "removing it";
    for (const tid of tids) {
      if (notFoundRoutes.has(`${tid} ${h}`)) continue;
      out.diag("warning", "cloudflare-repair", `tunnel ${tid}: site route ${h} has no "infra-sync: web..." Access app (deleted out-of-band?); ${next}`);
    }
  }

  // A route built for an extra hostname (404 path rules before it) that the tool can no longer prove it
  // owns: kept as it is, like any rule the tool does not own.
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const h of new Set((tc.config?.ingress ?? []).map((r) => lc(r.hostname)))) {
      if (!h || isReservedName(h) || routeHosts.has(h) || ownedWebHostnames.has(h) || !notFoundRoutes.has(`${tid} ${h}`)) continue;
      out.warn(
        `${h}: tunnel ${tid} has a route with 404 rules for protected paths, but the tool can no longer prove it owns it (${h} is not declared under a droplet with a site, has no Access app and no "${DNS_COMMENT_MARKER}" CNAME); kept as it is. Remove it by hand if the site should leave the tunnel, or declare it again`,
      );
    }
  }

  // 4. Stale objects.
  const staleWebDns: WebResult["staleWebDns"] = [];
  for (const [name, list] of recsByName) {
    if (routeHosts.has(name)) continue;
    const owned = list.filter((x) => isOwnedWebDns(x.record));
    if (!owned.length) continue;
    if (!keepHost(name)) staleWebDns.push(...owned);
    else if (wanted.has(name)) staleWebDns.push(...owned.slice(1)); // duplicates of our own record
  }
  const staleWebIngress: StaleIngress[] = [];
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const h of new Set(ownedHostnamesIn(tc.config, noSsh, ownedWebHostnames))) {
      const w = wanted.get(h);
      if (w) {
        if (w.tunnelId !== tid) staleWebIngress.push({ tunnelId: tid, hostname: h, reason: "moved" });
      } else if (!keepHost(h)) {
        staleWebIngress.push({ tunnelId: tid, hostname: h, reason: "gone" });
      }
    }
  }
  const staleWebApps: AccessApp[] = [];
  for (const a of ownedApps) {
    const hosts = appDomains(a);
    if (!hosts.some(keepHost)) {
      staleWebApps.push(a);
      continue;
    }
    const w = hosts.length === 1 ? wanted.get(hosts[0]!) : undefined;
    if (!w) continue; // held: kept as it is
    // A wanted site keeps exactly the apps it plans (one per destination); the rest go
    // (exposure switched, path removed from the file, duplicates).
    if (!w.apps.some((p) => p.existingId === a.id)) staleWebApps.push(a);
  }

  return {
    sites,
    ownedWebHostnames,
    staleWebDns,
    staleWebIngress,
    staleWebApps,
    ownedCount: ownedApps.length + ownedDnsCount + ownedRouteCount,
    dnsErrorZones,
    dependents: scan.dependents,
    ownerOf,
  };
}

// ---------- 4e. allow.tunnel routes (new) ----------

interface RouteResult {
  routes: RoutePlan[];
  reports: RouteReport[];
  /** Hostnames that belong to routes: declared in a file, or carrying a tunnel-route app. */
  routeHosts: Set<string>;
  /** Route hostnames whose ingress rules the tool owns (a route app, or a marked CNAME on a declared route). */
  ownedRouteHostnames: Set<string>;
  staleRouteDns: Array<{ zoneId: string; record: DnsRecord }>;
  staleRouteIngress: StaleIngress[];
  staleRouteApps: AccessApp[];
  ownedCount: number;
}

function planRoutes(
  snap: Snapshot,
  cfg: Cfg,
  drops: Drop[],
  cands: Array<{ name: string; privateIp: string; tunnelId: string; zoneId: string; pending: boolean }>,
  tunnelErrors: Map<string, string>,
  dnsErrorZones: Set<string>,
  out: Sink,
): RouteResult {
  const zoneNames = snap.zones.map((z) => lc(z.name));
  const zoneIdByName = new Map(snap.zones.map((z) => [lc(z.name), z.id]));
  const dropletNames = new Set(drops.map((d) => lc(d.name)));

  // Declared routes, by hostname. Every declared hostname is held: never deleted while a file names it.
  const declared = new Map<string, Array<{ drop: Drop; port: { from: number; to: number; protocol: string; raw: string }; who: Who[] }>>();
  for (const d of drops) {
    for (const t of d.dd?.spec.allow.tunnel ?? []) {
      const h = lc(t.route);
      declared.set(h, [...(declared.get(h) ?? []), { drop: d, port: t.port, who: t.who }]);
    }
  }
  const siteHostnames = new Set<string>();
  for (const d of drops) if (d.site) for (const h of [d.name, ...d.site.hostnames]) siteHostnames.add(lc(h));

  const ownedApps = snap.apps.filter(isOwnedRouteApp);
  const ownedByHost = new Map<string, AccessApp[]>();
  for (const a of ownedApps) for (const h of appDomains(a)) ownedByHost.set(h, [...(ownedByHost.get(h) ?? []), a]);
  const routeHosts = new Set<string>([...declared.keys(), ...ownedByHost.keys()]);

  const recsByName = new Map<string, Array<{ zoneId: string; record: DnsRecord }>>();
  for (const z of snap.zones) {
    const recs = snap.zoneDns[z.id];
    if (!recs || isErr(recs)) continue;
    for (const r of recs) recsByName.set(lc(r.name), [...(recsByName.get(lc(r.name)) ?? []), { zoneId: z.id, record: r }]);
  }
  const ownedRouteHostnames = new Set<string>(ownedByHost.keys());
  let ownedDnsCount = 0;
  for (const h of routeHosts) {
    const n = (recsByName.get(h) ?? []).filter((x) => isOwnedWebDns(x.record)).length;
    if (n) {
      ownedRouteHostnames.add(h);
      ownedDnsCount += n;
    }
  }
  const foreignApps = new Map<string, string>();
  for (const a of snap.apps) {
    if (isOwnedRouteApp(a)) continue;
    for (const d of appDestinations(a)) foreignApps.set(d, a.name ?? a.id);
  }
  const foreignIngress = new Map<string, string>();
  const ownedIngress = new Map<string, string[]>();
  for (const [tid, tc] of Object.entries(snap.tunnels)) {
    if (isErr(tc)) continue;
    for (const r of tc.config?.ingress ?? []) {
      const h = lc(r.hostname);
      if (!h || !routeHosts.has(h)) continue;
      if (ownedRouteHostnames.has(h)) {
        if (!(ownedIngress.get(h) ?? []).includes(tid)) ownedIngress.set(h, [...(ownedIngress.get(h) ?? []), tid]);
      } else if (!foreignIngress.has(h)) foreignIngress.set(h, tid);
    }
  }

  const candByName = new Map(cands.map((c) => [c.name, c]));
  const routes: RoutePlan[] = [];
  const reports: RouteReport[] = [];
  for (const [h, list] of declared) {
    if (list.length > 1) {
      for (const x of list) out.conflict(x.drop.name, `allow.tunnel route ${h} is declared ${list.length} times; nothing changed for it`);
      continue;
    }
    const { drop, port, who } = list[0]!;
    const c = candByName.get(drop.name);
    if (!c) continue; // the droplet is not planned this run (reported above); its route is held
    if (port.protocol !== "tcp" || port.from !== port.to) {
      const reason =
        port.protocol !== "tcp"
          ? `${port.raw}: UDP goes through the Cloudflare One client's private-network route, which the tool does not build; add it by hand`
          : `${port.raw}: a tunnel route carries one TCP port; list each port as its own route`;
      reports.push({ name: drop.name, hostname: h, port: port.raw, who, reason });
      out.diag("warning", "cloudflare-route-not-built", `${h}: ${reason}`, drop.name);
      continue;
    }
    const f = flattenName(h, zoneNames);
    if (!f.ok || isReservedName(h) || h.slice(0, h.length - f.zone.length - 1).includes(".")) {
      out.warn(`${h}: allow.tunnel route refused: it must be a one-level name in an account zone, not starting with ${RESERVED_PREFIXES.join(" or ")}`, drop.name);
      continue;
    }
    if (dropletNames.has(h) || siteHostnames.has(h)) {
      out.conflict(drop.name, `allow.tunnel route ${h} is also a droplet name or a site hostname; nothing created for it`);
      continue;
    }
    const zoneId = zoneIdByName.get(f.zone)!;
    if (tunnelErrors.has(c.tunnelId) || dnsErrorZones.has(zoneId)) {
      out.skipped(drop.name, `route ${h} not managed this run: ${tunnelErrors.has(c.tunnelId) ? `tunnel ${c.tunnelId} configuration unavailable` : `DNS records of zone ${f.zone} unavailable`}`);
      continue;
    }
    const unknown = who.filter((w) => w.kind === "service-token" && !cfg.serviceTokens[w.name]);
    if (unknown.length) {
      out.warn(`${h}: service token ${unknown.map((w) => (w.kind === "service-token" ? w.name : "")).join(", ")} is not in account.cloudflare.service_tokens; nothing created for it`, drop.name);
      continue;
    }
    const reasons: string[] = [];
    const fa = foreignApps.get(h);
    if (fa) reasons.push(`Access app "${fa}" already covers ${h}`);
    if (foreignIngress.has(h)) reasons.push(`tunnel ${foreignIngress.get(h)} has an ingress rule for ${h} that the tool does not own`);
    const recs = recsByName.get(h) ?? [];
    const foreignDns = recs.filter((x) => !isOwnedWebDns(x.record));
    if (foreignDns.length) reasons.push(`DNS ${foreignDns.map((x) => `${x.record.type} ${x.record.name}`).join(", ")} has no "${DNS_COMMENT_MARKER}" comment; not overwritten`);
    if (reasons.length) {
      out.conflict(drop.name, `allow.tunnel route ${h}: ${reasons.join("; ")}; nothing created for it`);
      continue;
    }

    const body = routeAppBody(h, who, cfg.staffPolicyId, cfg.serviceTokens);
    const existing = ownedByHost.get(h)?.[0];
    let app: RoutePlan["app"];
    if (!existing) app = { op: "create", body };
    else if (sameWebApp(existing, body, h)) app = { op: "noop", existingId: existing.id, existing, body };
    else {
      const inlineExisting = (existing.policies ?? []).filter((p) => !p.reusable);
      const policies = body.policies.map((p) => (isLink(p) ? p : withPolicyIds([p], inlineExisting)[0]!));
      app = { op: "update", existingId: existing.id, existing, body: { ...body, policies } };
    }
    const dBody = dnsBody(h, c.tunnelId);
    const mine = recs.find((x) => isOwnedWebDns(x.record))?.record;
    const dns: RoutePlan["dns"] = !mine
      ? { op: "create", body: dBody }
      : {
          op: mine.type === "CNAME" && lc(mine.content) === lc(dBody.content) && mine.proxied === true ? "noop" : "update",
          existingId: mine.id,
          existing: mine,
          body: dBody,
        };
    routes.push({ name: drop.name, hostname: h, zoneId, tunnelId: c.tunnelId, ingressService: `tcp://${c.privateIp}:${port.from}`, app, dns, pending: c.pending });
  }

  // Stale: owned route objects for a hostname no file declares any more.
  const wanted = new Map(routes.map((r) => [r.hostname, r]));
  const keep = (h: string) => wanted.has(h) || declared.has(h);
  const staleRouteDns: RouteResult["staleRouteDns"] = [];
  for (const h of routeHosts) {
    const owned = (recsByName.get(h) ?? []).filter((x) => isOwnedWebDns(x.record));
    if (!keep(h)) staleRouteDns.push(...owned);
    else if (wanted.has(h)) staleRouteDns.push(...owned.slice(1));
  }
  const staleRouteIngress: StaleIngress[] = [];
  for (const [h, tids] of ownedIngress) {
    const w = wanted.get(h);
    for (const tid of tids) {
      if (w) {
        if (w.tunnelId !== tid) staleRouteIngress.push({ tunnelId: tid, hostname: h, reason: "moved" });
      } else if (!keep(h)) staleRouteIngress.push({ tunnelId: tid, hostname: h, reason: "gone" });
    }
  }
  const staleRouteApps: AccessApp[] = [];
  for (const a of ownedApps) {
    const hs = appDomains(a);
    if (!hs.some(keep)) {
      staleRouteApps.push(a);
      continue;
    }
    const w = hs.length === 1 ? wanted.get(hs[0]!) : undefined;
    if (w && w.app.existingId !== a.id) staleRouteApps.push(a); // a duplicate
  }
  let ownedIngressCount = 0;
  for (const tids of ownedIngress.values()) ownedIngressCount += tids.length;
  return {
    routes,
    reports,
    routeHosts,
    ownedRouteHostnames,
    staleRouteDns,
    staleRouteIngress,
    staleRouteApps,
    ownedCount: ownedApps.length + ownedDnsCount + ownedIngressCount,
  };
}
