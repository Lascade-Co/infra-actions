// Request bodies and the comparisons that decide create / update / noop. Ported unchanged in
// behaviour from the infra-sync Worker (src/plan.ts there): every predicate here is what decides
// whether the tool sees a difference against what the Worker built, so keep them exactly as they are.
// Changed on purpose (decision 18): the infrastructure apps (one per SSH access set, ubuntu only),
// the target tags (plus ssh-access=<set id>) and the people on each droplet's ssh- app.

import { createHash } from "node:crypto";
import {
  DEFAULT_WEB_ORIGIN,
  DNS_COMMENT_MARKER,
  HEALTH_APP_PREFIX,
  HEALTH_BYPASS_PATH,
  INFRA_APP_PREFIX,
  LEGACY_INFRA_APP_NAME,
  NAME_PREFIX,
  RESERVED_PREFIXES,
  SSH_ACCESS_TAG_KEY,
  SSH_USERNAME,
  TARGET_TAG_KEY,
  TARGET_TAG_VALUE,
  VPC_PREFIX,
  VPC_TTL,
  WEB_ADMIN_APP_PREFIX,
  WEB_APP_PREFIX,
  WEB_EXCEPTION_APP_PREFIX,
} from "../core/constants.js";
import type { EnvName, WebException, Who } from "../core/model.js";
import { type IngressTarget, protectedPathRegex } from "./ingress.js";
import type { AccessApp, AccessPolicy, AccessRule, DnsRecord, InfraTarget } from "./types.js";

/**
 * Access apps for allow.tunnel routes (new in this tool; the Worker had none). A prefix of its own,
 * so the Worker-era rules never mistake them for ssh- apps (which would make them stale).
 */
export const TUNNEL_APP_PREFIX = "infra-sync: tunnel ";

export const lc = (s: string | undefined | null) => (s ?? "").toLowerCase();

// ---------- ownership ----------

export const isOwnedHealthApp = (a: AccessApp) => (a.name ?? "").startsWith(HEALTH_APP_PREFIX) && a.type === "self_hosted";
export type WebAppKind = "site" | "admin" | "exception";
export function webAppKind(name: string | undefined): WebAppKind | undefined {
  const n = name ?? "";
  if (n.startsWith(WEB_APP_PREFIX)) return "site";
  if (n.startsWith(WEB_ADMIN_APP_PREFIX)) return "admin";
  if (n.startsWith(WEB_EXCEPTION_APP_PREFIX)) return "exception";
  return undefined;
}
/** The tool's site apps: "infra-sync: web <H>", "infra-sync: web-admin <H>/<path>", "infra-sync: web-exception <H>/<path>". */
export const isOwnedWebApp = (a: AccessApp) => a.type === "self_hosted" && webAppKind(a.name) !== undefined;
/** The tool's allow.tunnel route apps: "infra-sync: tunnel <H>". */
export const isOwnedRouteApp = (a: AccessApp) => a.type === "self_hosted" && (a.name ?? "").startsWith(TUNNEL_APP_PREFIX);
/** The tool's ssh- apps (not the infrastructure app, not healthcheck, site or tunnel-route apps). */
export const isOwnedApp = (a: AccessApp) =>
  (a.name ?? "").startsWith(NAME_PREFIX) &&
  a.type === "self_hosted" &&
  a.name !== LEGACY_INFRA_APP_NAME &&
  !isOwnedHealthApp(a) &&
  !isOwnedWebApp(a) &&
  !isOwnedRouteApp(a);
export const isOwnedTarget = (t: InfraTarget) => t.tags?.[TARGET_TAG_KEY] === TARGET_TAG_VALUE;
export const isOwnedDns = (r: DnsRecord) => (r.comment ?? "").startsWith(DNS_COMMENT_MARKER);
export const isOwnedVpcDns = (r: DnsRecord) => isOwnedDns(r) && lc(r.name).startsWith(VPC_PREFIX);
/**
 * The tool's infrastructure apps: "infra-sync: SSH <set id>", and the Worker's single
 * "infra-sync: SSH targets" (stale once every target is covered by a set app).
 */
export const isOwnedInfraApp = (a: AccessApp) => a.type === "infrastructure" && (a.name ?? "").startsWith(INFRA_APP_PREFIX);
export const isReservedName = (h: string) => RESERVED_PREFIXES.some((p) => lc(h).startsWith(p));
/** A site CNAME the tool created: marked, CNAME, and not one of the generated ssh-/vpc- names. */
export const isOwnedWebDns = (r: DnsRecord) => isOwnedDns(r) && r.type === "CNAME" && !isReservedName(r.name);

/** Hostnames (no path) an app covers. */
export function appDomains(a: AccessApp): string[] {
  const out = new Set<string>();
  if (a.domain) out.add(lc(a.domain).split("/")[0]!);
  for (const d of a.self_hosted_domains ?? []) out.add(lc(d).split("/")[0]!);
  for (const d of a.destinations ?? []) if (d.uri) out.add(lc(d.uri).split("/")[0]!);
  return [...out];
}

/** Full destinations (host/path, lowercase, no trailing slash) an app covers. */
export function appDestinations(a: AccessApp): string[] {
  const out = new Set<string>();
  const add = (d?: string) => d && out.add(lc(d).replace(/\/+$/, ""));
  add(a.domain);
  for (const d of a.self_hosted_domains ?? []) add(d);
  for (const d of a.destinations ?? []) add(d.uri);
  return [...out];
}

// ---------- bodies ----------

export interface TargetBody {
  hostname: string;
  /** virtual_network_id omitted => default virtual network */
  ip: { ipv4: { ip_addr: string } };
  tags: Record<string, string>;
}
export interface AppBody {
  name: string;
  type: "self_hosted";
  domain: string;
  app_launcher_visible: boolean;
  session_duration: string;
  policies: AccessPolicy[];
}
export interface InfraAppBody {
  name: string;
  type: "infrastructure";
  target_criteria: Array<{ port: number; protocol: "SSH"; include: { tags: Record<string, string[]> } }>;
  policies: AccessPolicy[];
}
export interface DnsBody {
  type: "CNAME";
  name: string;
  content: string;
  proxied: true;
  ttl: 1;
  comment: string;
}
export interface VpcBody {
  type: "A";
  name: string;
  content: string;
  proxied: false;
  ttl: number;
  comment: string;
}
/** A reusable (account-level) policy attached to an app by id. */
export interface PolicyLink {
  id: string;
  precedence: number;
}
export interface WebAppBody {
  name: string;
  type: "self_hosted";
  domain: string;
  app_launcher_visible: boolean;
  session_duration: string;
  allow_authenticate_via_warp?: boolean;
  policies: Array<AccessPolicy | PolicyLink>;
}

/**
 * `setId`: the droplet's SSH access set (sshAccessSetId), as the tag the set's infrastructure app
 * selects. Tags the tool doesn't manage (other keys on an existing target) are kept.
 */
export function targetBody(name: string, ip: string, setId: string, existingTags: Record<string, string> = {}): TargetBody {
  const kept = Object.fromEntries(Object.entries(existingTags).filter(([k]) => k !== TARGET_TAG_KEY && k !== SSH_ACCESS_TAG_KEY));
  return { hostname: name, ip: { ipv4: { ip_addr: ip } }, tags: { ...kept, [TARGET_TAG_KEY]: TARGET_TAG_VALUE, [SSH_ACCESS_TAG_KEY]: setId } };
}

/** Tags compared by key and value, order ignored. */
export const sameTags = (a: Record<string, string> | undefined, b: Record<string, string>): boolean => {
  const norm = (t: Record<string, string>) => JSON.stringify(Object.entries(t).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a ?? {}) === norm(b);
};

// ---------- SSH access sets (decision 18) ----------

/**
 * A stable id for a set of people who may SSH (lowercase, deduplicated, sorted emails): the first
 * 12 hex digits of its SHA-256. Droplets with the same people share one infrastructure app.
 */
export function sshAccessSetId(emails: readonly string[]): string {
  const norm = [...new Set(emails.map((e) => e.trim().toLowerCase()))].sort();
  return createHash("sha256").update(norm.join("\n")).digest("hex").slice(0, 12);
}

export const infraAppName = (setId: string) => INFRA_APP_PREFIX + setId;

/** Who an app lets in and as which users: the emails of its Allow policies, their SSH usernames. */
export interface SshAccessView {
  emails: string[];
  usernames: string[];
}

export function sshAccessOf(apps: readonly AccessApp[]): SshAccessView {
  const emails = new Set<string>();
  const users = new Set<string>();
  for (const a of apps) {
    for (const p of a.policies ?? []) {
      if (p.decision !== "allow") continue;
      for (const r of p.include ?? []) {
        const e = (r as { email?: { email?: string } }).email?.email;
        if (e) emails.add(lc(e));
      }
      for (const u of p.connection_rules?.ssh?.usernames ?? []) users.add(u);
    }
  }
  return { emails: [...emails].sort(), usernames: [...users].sort() };
}

/** True when one of the app's target criteria selects a target with these tags (every tag key must match). */
export function appSelects(a: AccessApp, tags: Record<string, string> | undefined): boolean {
  return (a.target_criteria ?? []).some((c) => {
    const want = (c as { include?: { tags?: Record<string, string[]> } }).include?.tags ?? {};
    const keys = Object.keys(want);
    return keys.length > 0 && keys.every((k) => tags?.[k] !== undefined && (want[k] ?? []).includes(tags[k]!));
  });
}

const emailRules = (emails: string[]): AccessRule[] => emails.map((email) => ({ email: { email } }));
const tokenRules = (ids: string[]): AccessRule[] => ids.map((token_id) => ({ service_token: { token_id } }));

/**
 * The droplet's ssh- route app: CI deploy tokens (deploy targets), then the droplet's SSH access
 * list. The policy keeps the Worker's name "ssh-admins", so a droplet whose list equals the Worker's
 * admins shows no change.
 */
/** Name of the Allow policy on a droplet's ssh- app that lists its people (the Worker's name). */
export const SSH_LIST_POLICY = `${NAME_PREFIX} ssh-admins`;

export function appBody(sshHostname: string, sshEmails: string[], tokenIds: string[], env?: EnvName): AppBody {
  const policies: AccessPolicy[] = [];
  if (tokenIds.length) {
    policies.push({
      name: `${NAME_PREFIX} ci-deploy (${env})`,
      decision: "non_identity", // "Service Auth"
      include: tokenRules(tokenIds),
    });
  }
  policies.push({ name: SSH_LIST_POLICY, decision: "allow", include: emailRules(sshEmails) });
  policies.forEach((p, i) => (p.precedence = i + 1));
  return {
    name: `${NAME_PREFIX} ${sshHostname}`,
    type: "self_hosted",
    domain: sshHostname,
    app_launcher_visible: false,
    session_duration: "24h",
    policies,
  };
}

/** One SSH access set: port 22 of every target tagged ssh-access=<set id>, for these people, as ubuntu only. */
/**
 * A frozen droplet's ssh- app with only its people changed: the existing app as it is, with the
 * include list of its SSH_LIST_POLICY replaced. Undefined when the app has no such policy.
 */
export function sshListOnlyAppBody(existing: AccessApp, sshEmails: string[]): AppBody | undefined {
  const ps = existing.policies ?? [];
  if (!ps.some((p) => p.name === SSH_LIST_POLICY && p.decision === "allow")) return undefined;
  return {
    name: existing.name ?? "",
    type: "self_hosted",
    domain: existing.domain ?? "",
    app_launcher_visible: existing.app_launcher_visible ?? false,
    session_duration: existing.session_duration ?? "24h",
    policies: ps.map((p, i) => ({
      ...(p.id ? { id: p.id } : {}),
      name: p.name,
      decision: p.decision,
      include: p.name === SSH_LIST_POLICY && p.decision === "allow" ? emailRules(sshEmails) : p.include,
      ...(p.exclude?.length ? { exclude: p.exclude } : {}),
      ...(p.require?.length ? { require: p.require } : {}),
      precedence: p.precedence ?? i + 1,
    })),
  };
}

export function infraAppBody(setId: string, emails: string[]): InfraAppBody {
  return {
    name: infraAppName(setId),
    type: "infrastructure",
    target_criteria: [{ port: 22, protocol: "SSH", include: { tags: { [SSH_ACCESS_TAG_KEY]: [setId] } } }],
    policies: [
      {
        name: `${NAME_PREFIX} ssh-access`,
        decision: "allow",
        include: emailRules(emails),
        connection_rules: { ssh: { usernames: [SSH_USERNAME] } },
        precedence: 1,
      },
    ],
  };
}

export function dnsBody(hostname: string, tunnelId: string): DnsBody {
  return { type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: DNS_COMMENT_MARKER };
}

export function vpcBody(vpcHostname: string, ip: string): VpcBody {
  return { type: "A", name: vpcHostname, content: ip, proxied: false, ttl: VPC_TTL, comment: DNS_COMMENT_MARKER };
}

export function healthAppBody(dropletName: string): AppBody {
  return {
    name: HEALTH_APP_PREFIX + dropletName,
    type: "self_hosted",
    domain: `${dropletName}/${HEALTH_BYPASS_PATH}`,
    app_launcher_visible: false,
    session_duration: "24h",
    policies: [{ name: `${NAME_PREFIX} public healthcheck`, decision: "bypass", include: [{ everyone: {} }], precedence: 1 }],
  };
}

const STAFF_SESSION = "24h";

/** A staff site: the whole hostname, for the account's reusable "staff" policy. */
export function webSiteAppBody(hostname: string, staffPolicyId: string): WebAppBody {
  return {
    name: WEB_APP_PREFIX + hostname,
    type: "self_hosted",
    domain: hostname,
    app_launcher_visible: false,
    session_duration: STAFF_SESSION,
    // Devices enrolled in the Cloudflare One client get in on their WARP session, without a login page.
    allow_authenticate_via_warp: true,
    policies: [{ id: staffPolicyId, precedence: 1 }],
  };
}

/** A public site: one protected path (e.g. /admin), for the reusable "staff" policy. */
export function webAdminAppBody(hostname: string, path: string, staffPolicyId: string): WebAppBody {
  return { ...webSiteAppBody(hostname, staffPolicyId), name: `${WEB_ADMIN_APP_PREFIX}${hostname}${path}`, domain: `${hostname}${path}` };
}

/**
 * An exception path: Bypass for everyone or for IP ranges (exactly the Worker's body), plus, new in
 * this tool, a Service Auth policy for named service tokens (`tokenIds`, resolved by the planner).
 */
export function webExceptionAppBody(hostname: string, e: WebException, tokenIds: string[] = []): WebAppBody {
  const policies: AccessPolicy[] = [];
  if (e.allow === "everyone") {
    policies.push({ name: `${NAME_PREFIX} web exception`, decision: "bypass", include: [{ everyone: {} }] });
  } else {
    const ips = e.allow.ips ?? [];
    if (ips.length) policies.push({ name: `${NAME_PREFIX} web exception`, decision: "bypass", include: ips.map((ip) => ({ ip: { ip } })) });
    if (tokenIds.length) policies.push({ name: `${NAME_PREFIX} web exception service tokens`, decision: "non_identity", include: tokenRules(tokenIds) });
  }
  policies.forEach((p, i) => (p.precedence = i + 1));
  return {
    name: `${WEB_EXCEPTION_APP_PREFIX}${hostname}${e.path}`,
    type: "self_hosted",
    domain: `${hostname}${e.path}`,
    app_launcher_visible: false,
    session_duration: STAFF_SESSION,
    policies,
  };
}

/**
 * An allow.tunnel route: Service Auth for the named service tokens first, then the reusable staff
 * policy. Staff devices enrolled in the Cloudflare One client get in on their WARP session.
 */
export function routeAppBody(hostname: string, who: Who[], staffPolicyId: string, serviceTokens: Record<string, string>): WebAppBody {
  const tokenIds = [...new Set(who.flatMap((w) => (w.kind === "service-token" && serviceTokens[w.name] ? [serviceTokens[w.name]!] : [])))].sort();
  const staff = who.some((w) => w.kind === "staff");
  const policies: Array<AccessPolicy | PolicyLink> = [];
  if (tokenIds.length) policies.push({ name: `${NAME_PREFIX} tunnel service tokens`, decision: "non_identity", include: tokenRules(tokenIds) });
  if (staff) policies.push({ id: staffPolicyId, precedence: 0 });
  policies.forEach((p, i) => (p.precedence = i + 1));
  return {
    name: TUNNEL_APP_PREFIX + hostname,
    type: "self_hosted",
    domain: hostname,
    app_launcher_visible: false,
    session_duration: STAFF_SESSION,
    ...(staff ? { allow_authenticate_via_warp: true } : {}),
    policies,
  };
}

/**
 * Tunnel route target: https origins keep their certificate but it is not checked.
 * `notFoundPaths` (protected paths of a public site's extra hostname) become 404 rules before the route.
 */
export function webIngress(origin: string | undefined, privateIp: string, notFoundPaths: string[] = []): IngressTarget {
  const service = (origin ?? DEFAULT_WEB_ORIGIN).replace("{ip}", privateIp);
  const t: IngressTarget = /^https:/i.test(service) ? { service, originRequest: { noTLSVerify: true } } : { service };
  if (notFoundPaths.length) t.notFoundPaths = notFoundPaths.map(protectedPathRegex);
  return t;
}

// ---------- normalisation for idempotent comparison ----------

export const isLink = (p: AccessPolicy | PolicyLink): p is PolicyLink => !("decision" in p);

function normRule(r: AccessRule): string {
  const any = r as Record<string, { email?: string; token_id?: string } | undefined>;
  if (any.email?.email) return `email:${lc(any.email.email)}`;
  if (any.service_token?.token_id) return `token:${lc(any.service_token.token_id)}`;
  return JSON.stringify(r);
}

export function normPolicies(ps: AccessPolicy[] | undefined): string {
  const list = (ps ?? []).map((p, i) => ({
    order: p.precedence ?? i + 1,
    name: p.name,
    decision: p.decision,
    include: (p.include ?? []).map(normRule).sort(),
    exclude: (p.exclude ?? []).map(normRule).sort(),
    require: (p.require ?? []).map(normRule).sort(),
    users: [...(p.connection_rules?.ssh?.usernames ?? [])].sort(),
  }));
  list.sort((a, b) => a.order - b.order);
  return JSON.stringify(list.map(({ order: _o, ...rest }) => rest));
}

/** Reusable policies are compared by id only: the API returns them expanded (name, include, ...). */
export function samePolicies(existing: AccessPolicy[] | undefined, desired: Array<AccessPolicy | PolicyLink>): boolean {
  if (desired.every(isLink)) {
    const ids = (existing ?? [])
      .map((p, i) => ({ order: p.precedence ?? i + 1, id: lc(p.id) }))
      .sort((a, b) => a.order - b.order)
      .map((x) => x.id);
    return JSON.stringify(ids) === JSON.stringify(desired.map((p) => lc(p.id)));
  }
  if (desired.some(isLink)) return sameMixedPolicies(existing, desired); // new: allow.tunnel apps (tokens + staff)
  return normPolicies(existing) === normPolicies(desired as AccessPolicy[]);
}

/** Inline and reusable policies in one list (only allow.tunnel route apps build these; the Worker never did). */
function sameMixedPolicies(existing: AccessPolicy[] | undefined, desired: Array<AccessPolicy | PolicyLink>): boolean {
  const ex = (existing ?? []).map((p, i) => ({ order: p.precedence ?? i + 1, p })).sort((a, b) => a.order - b.order);
  if (ex.length !== desired.length) return false;
  return desired.every((d, k) => {
    const e = ex[k]!.p;
    return isLink(d) ? lc(e.id) === lc(d.id) : !e.reusable && normPolicies([{ ...e, precedence: 1 }]) === normPolicies([{ ...d, precedence: 1 }]);
  });
}

export function sameWebApp(existing: AccessApp, body: WebAppBody, destination: string): boolean {
  return (
    existing.name === body.name &&
    // Destinations, not the raw domain: the API may drop a trailing slash.
    appDestinations(existing).join() === destination &&
    (body.allow_authenticate_via_warp === undefined || existing.allow_authenticate_via_warp === body.allow_authenticate_via_warp) &&
    samePolicies(existing.policies, body.policies)
  );
}

export function normCriteria(c: unknown[] | undefined): string {
  return JSON.stringify(
    (c ?? []).map((x) => {
      const o = x as { port?: unknown; protocol?: unknown; include?: { tags?: Record<string, string[]> }; target_attributes?: unknown; exclude?: unknown; require?: unknown };
      const tags = o.include?.tags ?? {};
      const sortedTags = Object.fromEntries(
        Object.keys(tags)
          .sort()
          .map((k) => [k, [...tags[k]!].sort()]),
      );
      return { port: o.port, protocol: o.protocol, tags: sortedTags, attrs: o.target_attributes ?? null, ex: o.exclude ?? null, rq: o.require ?? null };
    }),
  );
}

/** Carry existing app-scoped policy ids (matched by name) so an update edits rather than duplicates them. */
export function withPolicyIds(desired: AccessPolicy[], existing: AccessPolicy[] | undefined): AccessPolicy[] {
  const byName = new Map((existing ?? []).filter((p) => p.id).map((p) => [p.name, p.id!]));
  return desired.map((p) => (byName.has(p.name) ? { ...p, id: byName.get(p.name) } : p));
}
