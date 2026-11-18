// Pure tunnel-ingress merge, ported from the infra-sync Worker (src/ingress.ts there).
//
// A tunnel configuration is one document shared with rules people add by hand. Only rules the
// tool owns are rewritten:
//
//   owned(rule) := (rule.hostname starts with "ssh-"  AND  rule.hostname is in `owned`)
//               OR (rule.hostname does not start with "ssh-"  AND  rule.hostname is in `ownedWeb`)
//
// `owned` holds the domains of the tool's ssh- Access apps, `ownedWeb` the hosts of its site and
// tunnel-route apps (plus, for both, the names of marked DNS records, and for sites the extra
// hostnames declared in droplet files; computed in plan.ts). Ingress rules have no comment field,
// so ownership is proven by the Access app the tool always creates BEFORE the rule and deletes
// AFTER it, or by the DNS record created after it and deleted before it.
//
// Every other rule is kept byte for byte and in its original order. The catch-all (last rule,
// no hostname, no path) stays last; http_status:404 is added if missing.
//
// An owned hostname H has a GROUP of rules: optional path rules (e.g. 404 for the protected paths
// of a public site's extra hostname) immediately followed by its main rule. The group is one unit:
// compared as a whole, rewritten in place (at the position of H's first rule), removed as a whole.

import type { IngressRule, TunnelConfigDoc } from "./types.js";

export const CATCH_ALL: IngressRule = { service: "http_status:404" };
export const NOT_FOUND_SERVICE = "http_status:404";

/** What an owned hostname should route to. */
export interface IngressTarget {
  /** e.g. ssh://10.0.0.5:22 or https://10.0.0.5:443 */
  service: string;
  /** e.g. {noTLSVerify: true} */
  originRequest?: Record<string, unknown>;
  /** Path regexes answered with http_status:404, as rules placed right before the main rule. */
  notFoundPaths?: string[];
}

/** An explicit rule group (used by apply, which replays the group the plan computed). */
export interface IngressGroup {
  rules: IngressRule[];
}

export type UpsertTarget = string | IngressTarget | IngressGroup;

export interface IngressChange {
  /** hostname -> target */
  upserts: Map<string, UpsertTarget>;
  /** owned hostnames to drop from this tunnel */
  removes: Set<string>;
  /** provably owned ssh- hostnames (lowercase) */
  owned: Set<string>;
  /** provably owned site / tunnel-route hostnames (lowercase, never ssh-) */
  ownedWeb?: Set<string>;
}

/**
 * Tunnel ingress `path` regex for a protected path: the path itself and everything under it, but
 * not unrelated prefixes (/admin -> ^/admin(/.*)?$, which does not match /administrator).
 * The path is used as written (cloudflared matches the regex case-sensitively), minus trailing slashes.
 */
export function protectedPathRegex(path: string): string {
  const p = path.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${p}(/.*)?$`;
}

export interface MergeResult {
  config: TunnelConfigDoc;
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  /** upserts that collide with a rule the tool does not own */
  conflicts: string[];
}

const lc = (s: string | undefined) => (s ?? "").toLowerCase();

export function isOwnedRule(rule: IngressRule, owned: Set<string>, ownedWeb: Set<string> = new Set()): boolean {
  const h = lc(rule.hostname);
  if (!h) return false;
  return h.startsWith("ssh-") ? owned.has(h) : ownedWeb.has(h);
}

/** JSON with sorted keys, for comparing originRequest objects. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const isGroup = (t: UpsertTarget): t is IngressGroup => typeof t === "object" && "rules" in t;

/** The rules of one hostname, in order: its 404 path rules, then its main rule. */
export function toGroup(hostname: string, t: UpsertTarget): IngressRule[] {
  if (isGroup(t)) return structuredClone(t.rules);
  const target: IngressTarget = typeof t === "string" ? { service: t } : t;
  const main: IngressRule = target.originRequest
    ? { hostname, service: target.service, originRequest: structuredClone(target.originRequest) }
    : { hostname, service: target.service };
  return [...(target.notFoundPaths ?? []).map((path) => ({ hostname, path, service: NOT_FOUND_SERVICE })), main];
}

/** Field-wise, so keys the API may add to a rule never cause a rewrite every run. */
export function sameRule(a: IngressRule, b: IngressRule): boolean {
  return a.service === b.service && (a.path ?? "") === (b.path ?? "") && canon(a.originRequest) === canon(b.originRequest);
}

/** Same hostname and same rules, in order. */
export function sameGroup(a: readonly IngressRule[], b: readonly IngressRule[]): boolean {
  return a.length === b.length && a.every((r, k) => lc(r.hostname) === lc(b[k]!.hostname) && sameRule(r, b[k]!));
}

function isCatchAll(rule: IngressRule | undefined): boolean {
  return !!rule && !rule.hostname && !rule.path;
}

/** Every rule for `hostname` in the configuration, in order. */
export function rulesFor(config: TunnelConfigDoc | undefined, hostname: string): IngressRule[] {
  const h = lc(hostname);
  return (config?.ingress ?? []).filter((r) => lc(r.hostname) === h);
}

/** True when the configuration carries exactly the route group built for `hostname`. */
export function routeLive(config: TunnelConfigDoc | undefined, hostname: string, target: UpsertTarget): boolean {
  const rules = rulesFor(config, hostname);
  const want = toGroup(lc(hostname), target);
  return rules.length === want.length && rules.every((r, k) => sameRule(r, want[k]!));
}

/** Owned hostnames with at least one rule in this tunnel (each once, in order of first rule). */
export function ownedHostnamesIn(config: TunnelConfigDoc | undefined, owned: Set<string>, ownedWeb?: Set<string>): string[] {
  return [...new Set((config?.ingress ?? []).filter((r) => isOwnedRule(r, owned, ownedWeb)).map((r) => lc(r.hostname)))];
}

export function mergeIngress(config: TunnelConfigDoc | undefined, change: IngressChange): MergeResult {
  // Round-trip every top-level key verbatim (warp-routing, originRequest, unknown keys).
  const base: TunnelConfigDoc = structuredClone(config ?? {});
  const original = base.ingress ?? [];
  // Upsert hostnames are NOT added to the owned set: an existing rule for an upsert hostname
  // that is not provably ours is a conflict, never an overwrite.
  const owned = new Set([...change.owned].map(lc));
  const ownedWeb = new Set([...(change.ownedWeb ?? [])].map(lc));
  const upserts = new Map([...change.upserts].map(([h, t]) => [lc(h), t] as const));

  // Each hostname is reported at most once, in one of added / updated / removed.
  const added: string[] = [];
  const updatedSet = new Set<string>();
  const removedSet = new Set<string>();
  const conflictSet = new Set<string>();

  let catchAll: IngressRule | undefined;
  let body = original;
  if (isCatchAll(original[original.length - 1])) {
    catchAll = original[original.length - 1];
    body = original.slice(0, -1);
  }

  // Positions of every owned rule, by hostname (a hostname's rules are all owned or all foreign).
  const ownedAt = new Map<string, number[]>();
  body.forEach((rule, i) => {
    if (isOwnedRule(rule, owned, ownedWeb)) ownedAt.set(lc(rule.hostname), [...(ownedAt.get(lc(rule.hostname)) ?? []), i]);
  });

  const out: IngressRule[] = [];
  const placed = new Set<string>(); // upserted hostnames whose group has been written
  const catchAllFor = new Set<string>(); // kept hostnames that already have a rule without a path
  body.forEach((rule, i) => {
    const h = lc(rule.hostname);
    if (!isOwnedRule(rule, owned, ownedWeb)) {
      out.push(rule); // foreign rule: untouched
      if (h && upserts.has(h)) conflictSet.add(h);
      return;
    }
    if (change.removes.has(h) && !upserts.has(h)) {
      removedSet.add(h); // the whole group goes
      return;
    }
    const target = upserts.get(h);
    if (target === undefined) {
      // Owned but not managed this run: kept as it is, except a copy shadowed by an earlier
      // rule for the same hostname without a path.
      if (catchAllFor.has(h)) {
        updatedSet.add(h);
        return;
      }
      out.push(rule);
      if (!rule.path) catchAllFor.add(h);
      return;
    }
    if (placed.has(h)) return; // a non-contiguous copy: the group was already written at the first rule
    placed.add(h);
    // The group is anchored at the hostname's first rule, keeping its place among foreign rules.
    const at = ownedAt.get(h)!;
    const existing = at.map((j) => body[j]!);
    const want = toGroup(h, target);
    const contiguous = at.every((j, k) => j === i + k);
    if (contiguous && existing.length === want.length && existing.every((r, k) => sameRule(r, want[k]!))) {
      out.push(...existing);
    } else {
      out.push(...want);
      updatedSet.add(h);
    }
  });

  // New owned groups go before the first rule that could shadow them (no hostname or a wildcard
  // hostname); otherwise at the end, before the catch-all.
  const newRules: IngressRule[] = [];
  for (const [h, target] of [...upserts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (placed.has(h) || conflictSet.has(h)) continue;
    newRules.push(...toGroup(h, target));
    added.push(h);
  }
  const updated = [...updatedSet];
  const removed = [...removedSet];
  const conflicts = [...conflictSet];
  if (newRules.length) {
    let at = out.findIndex((r) => !r.hostname || r.hostname.includes("*"));
    if (at < 0) at = out.length;
    out.splice(at, 0, ...newRules);
  }

  const finalIngress = out.length || catchAll ? [...out, catchAll ?? { ...CATCH_ALL }] : [];
  // Only write when an owned rule actually changes; never rewrite a tunnel just to normalise
  // rules that are not ours.
  const changed = added.length + updated.length + removed.length > 0 && JSON.stringify(finalIngress) !== JSON.stringify(original);
  if (changed) base.ingress = finalIngress;
  return { config: changed ? base : structuredClone(config ?? {}), changed, added, updated, removed, conflicts };
}
