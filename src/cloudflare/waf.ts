// Decision 21: block percent-encoded slashes on sites with login paths.
//
// An Access app on host/admin does not cover /admin%2Fx: Access doesn't decode the path, and the
// origin may (README "How Cloudflare matches paths"). So for every zone with at least one hostname
// that has a path-level login app, the tool owns exactly one WAF custom rule that blocks requests
// whose raw path contains %2F or %5C (any case) on those hostnames. The rule is the tool's by its
// description (WAF_RULE_DESCRIPTION); every other custom rule in the zone is left alone.
//
// Pure: planWaf turns the desired state, the planned sites and the observed entry point rulesets
// into "waf-rule" ops (one per zone, key = zone name). before/after are { hosts } (what the PR
// comment shows); apply rebuilds the request body from after.hosts with wafRuleBody.

import { WAF_RULE_DESCRIPTION } from "../core/constants.js";
import type { DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import { flattenName } from "../core/naming.js";
import type { Json, PlanOp } from "../core/plan.js";
import { isReservedName, lc } from "./bodies.js";
import type { WebSitePlan } from "./plan.js";
import type { CloudflareObserved, ReadError, WafRule } from "./types.js";

/**
 * The path test, on the raw path (before Cloudflare's URL normalization; the query string is not
 * part of it). `contains` is case-sensitive, so the path is lowercased first; `matches` (regex)
 * is not available on the Free plan.
 */
export const WAF_PATH_TEST = 'lower(raw.http.request.uri.path) contains "%2f" or lower(raw.http.request.uri.path) contains "%5c"';

/** Custom rules per zone (all rules of the http_request_firewall_custom phase), by zone plan. */
export const WAF_RULE_LIMITS: Record<string, number> = { free: 5, pro: 20, business: 100, enterprise: 1000 };
/** The limit used when the zone listing does not say the plan: the smallest (Free). */
export const WAF_DEFAULT_RULE_LIMIT = 5;
/** Cloudflare's maximum length of a rule expression. */
export const WAF_EXPRESSION_MAX = 4096;

const HOST_RE = /^[a-z0-9.-]+$/;

/** The rule's expression for these hostnames (lowercased, deduplicated, sorted). */
export function wafExpression(hosts: readonly string[]): string {
  const list = [...new Set(hosts.map(lc))].sort();
  return `(http.host in {${list.map((h) => `"${h}"`).join(" ")}}) and (${WAF_PATH_TEST})`;
}

/** The request body of the tool's rule for these hostnames. */
export function wafRuleBody(hosts: readonly string[]): Omit<WafRule, "id"> {
  return { description: WAF_RULE_DESCRIPTION, action: "block", expression: wafExpression(hosts), enabled: true };
}

/** The hostnames of an expression in exactly the tool's form, else undefined. */
export function hostsOfExpression(expression: string | undefined): string[] | undefined {
  const m = /^\(http\.host in \{([^}]*)\}\) and \((.*)\)$/.exec(expression ?? "");
  if (!m || m[2] !== WAF_PATH_TEST) return undefined;
  const hosts = m[1]!.trim() ? m[1]!.trim().split(/\s+/).map((h) => h.replace(/^"(.*)"$/, "$1")) : [];
  return wafExpression(hosts) === expression ? hosts : undefined;
}

/** What the PR comment shows of an existing rule: its hosts, and anything else that is not the tool's form. */
function ruleView(r: WafRule): Json {
  const hosts = hostsOfExpression(r.expression);
  return {
    ...(hosts ? { hosts } : { expression: r.expression ?? null }),
    ...(r.action !== "block" ? { action: r.action ?? null } : {}),
    ...(r.enabled === false ? { enabled: false } : {}),
  };
}

const isErr = (x: unknown): x is ReadError => !!x && typeof x === "object" && "error" in x;
const oneLevel = (h: string, zone: string) => !h.slice(0, h.length - zone.length - 1).includes(".");

/**
 * The hostnames that have a path-level login app, by zone name: a web.access path other than "/"
 * whose who-list has a person (staff, a group, an email).
 *  - The droplet's own name always; an extra hostname only when "/" is not [everyone] (on an
 *    open-root site those paths answer 404 in the tunnel there instead, no Access app).
 *  - Taken from the droplet files, so a site held back this run (a conflict, a read error) keeps
 *    its hostnames in the rule; plus the implicit hostnames (proxied CNAMEs to a site) the plan
 *    builds a path login app on.
 *  - Never a frozen droplet's (frozen: no change), and only names a site can have (in an account
 *    zone, one level under it, not ssh-/vpc-).
 */
export function loginPathHosts(desired: DesiredState, sites: readonly WebSitePlan[], zoneNames: readonly string[]): Map<string, string[]> {
  const frozen = new Set(desired.droplets.filter((d) => d.frozen).map((d) => d.name));
  const hosts = new Set<string>();
  for (const d of desired.droplets) {
    if (d.frozen || !d.web) continue;
    if (!d.web.access.some((a) => a.norm !== "" && a.needsLogin)) continue;
    hosts.add(lc(d.name));
    if (!d.web.rootOpen) for (const h of d.web.extraHostnames) hosts.add(lc(h));
  }
  for (const s of sites) {
    if (!frozen.has(s.name) && s.apps.some((a) => a.kind === "admin")) hosts.add(lc(s.hostname));
  }
  const byZone = new Map<string, string[]>();
  for (const h of hosts) {
    if (!HOST_RE.test(h) || isReservedName(h)) continue;
    const f = flattenName(h, zoneNames);
    if (!f.ok || !oneLevel(h, f.zone)) continue;
    byZone.set(f.zone, [...(byZone.get(f.zone) ?? []), h]);
  }
  for (const list of byZone.values()) list.sort();
  return byZone;
}

export interface WafPlan {
  ops: PlanOp[];
  unchanged: number;
  diagnostics: Diagnostic[];
}

export function planWaf(
  desired: DesiredState,
  observed: CloudflareObserved,
  sites: readonly WebSitePlan[],
  opts: { phase: number; deletionsAllowed: boolean; deletionBlockReason?: string },
): WafPlan {
  const ops: PlanOp[] = [];
  const diagnostics: Diagnostic[] = [];
  let unchanged = 0;
  const zoneNames = observed.zones.map((z) => lc(z.name));
  const wanted = loginPathHosts(desired, sites, zoneNames);
  const readErrors = new Map<string, string[]>();
  const del = opts.deletionsAllowed ? ("delete" as const) : ("report" as const);
  const delReason = (why: string) => (opts.deletionsAllowed ? why : `${why}; not deleted this run: ${opts.deletionBlockReason}`);
  const add = (op: Omit<PlanOp, "provider" | "module" | "kind">) =>
    ops.push({ provider: "cloudflare", module: "cloudflare", kind: "waf-rule", ...op, ids: { ...(op.ids ?? {}), phase: String(opts.phase) } });

  for (const z of [...observed.zones].sort((a, b) => lc(a.name).localeCompare(lc(b.name)))) {
    const zone = lc(z.name);
    const hosts = wanted.get(zone) ?? [];
    const rs = observed.waf[z.id];
    if (rs === undefined || isErr(rs)) {
      // One error per distinct failure (the zone id in the path aside), listing its zones.
      const text = rs ? rs.error.split(`/zones/${z.id}/`).join("/zones/{zone}/") : "not read";
      readErrors.set(text, [...(readErrors.get(text) ?? []), zone]);
      continue;
    }
    const rules = rs?.rules ?? [];
    const owned = rules.filter((r) => r.description === WAF_RULE_DESCRIPTION);
    const zoneIds = { zone: z.id, ...(rs ? { ruleset: rs.id } : {}) };
    const deleteOp = (r: WafRule, key: string, why: string) =>
      add({ key, action: del, before: ruleView(r), after: null, reason: delReason(why), ids: { ...zoneIds, id: r.id } });

    if (!hosts.length) {
      owned.forEach((r, i) => deleteOp(r, i ? `${zone} (duplicate ${r.id})` : zone, "no hostname in this zone has a path-level login app any more (decision 21)"));
      continue;
    }
    const after: Json = { hosts };
    const body = wafRuleBody(hosts);
    if (body.expression!.length > WAF_EXPRESSION_MAX) {
      const msg = `zone ${zone}: the rule that blocks encoded slashes would be ${body.expression!.length} characters, over Cloudflare's ${WAF_EXPRESSION_MAX}; not built (split the hostnames or ask for a change to the tool)`;
      diagnostics.push({ level: "warning", code: "cloudflare-conflict", message: msg });
      add({ key: zone, action: "report", before: owned[0] ? ruleView(owned[0]) : null, after, reason: msg });
      continue;
    }
    const [mine, ...dups] = owned;
    if (mine) {
      const same = mine.expression === body.expression && mine.action === "block" && mine.enabled !== false;
      if (same) unchanged++;
      else {
        const before = ruleView(mine);
        const had = hostsOfExpression(mine.expression);
        const hostsChanged = !!had && JSON.stringify(had) !== JSON.stringify(hosts);
        add({
          key: zone,
          action: "update",
          before,
          after,
          reason: hostsChanged
            ? "the hostnames with a path-level login app changed: block percent-encoded / and \\ (%2F, %5C) in their paths (decision 21)"
            : "the rule that blocks encoded slashes was changed outside the tool; put back (decision 21)",
          ids: { ...zoneIds, id: mine.id },
        });
      }
    } else {
      const limit = WAF_RULE_LIMITS[lc(z.plan?.legacy_id)] ?? WAF_DEFAULT_RULE_LIMIT;
      if (rs && rules.length >= limit) {
        const msg = `zone ${zone}: already has ${rules.length} WAF custom rules, the limit of its plan (${limit}); the rule that blocks encoded slashes on ${hosts.join(", ")} is not created. Free a slot (the tool never touches other rules)`;
        diagnostics.push({ level: "warning", code: "cloudflare-conflict", message: msg });
        add({ key: zone, action: "report", before: null, after, reason: msg });
      } else {
        add({
          key: zone,
          action: "create",
          before: null,
          after,
          reason: rs
            ? "block percent-encoded / and \\ (%2F, %5C) in paths on the hostnames with a path-level login app: Access does not decode them (decision 21)"
            : "block percent-encoded / and \\ (%2F, %5C) in paths on the hostnames with a path-level login app (decision 21); the zone has no custom rules yet, so its entry point ruleset is created with only this rule",
          ids: zoneIds,
        });
      }
    }
    for (const r of dups) deleteOp(r, `${zone} (duplicate ${r.id})`, "a duplicate of the tool's rule that blocks encoded slashes");
  }
  for (const [text, zones] of readErrors) {
    diagnostics.push({
      level: "error",
      code: "cloudflare-waf-read-error",
      message: `The WAF custom rules could not be read: the Cloudflare token needs the zone permission "Zone WAF: Edit" (API name "Zone WAF Write") on every zone of the account. Until they can be read, the rule that blocks encoded slashes (decision 21) is not planned there and nothing is applied. ${zones.length} zone(s): ${zones.join(", ")}. Error: ${text}`,
    });
  }
  return { ops, unchanged, diagnostics };
}
