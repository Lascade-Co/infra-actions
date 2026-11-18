// Pure: guard rail 1, ported from the infra-sync Worker (src/dependents.ts there). Finds every DNS
// record, in any account zone, that sends traffic to a site without being one of the site's own
// records ("dependents"), and the DNS-only wildcards that answer for site names whenever a specific
// record is missing.
//
// Why: Cloudflare follows a proxied CNAME to its target's origin but keeps the original Host. Once
// the target is a tunnel CNAME, the request reaches the tunnel with the dependent's Host, and the
// tunnel routes by Host only: without a route of its own, the dependent gets the catch-all 404.

import { DNS_COMMENT_MARKER, MAX_CNAME_CHAIN, RESERVED_PREFIXES } from "../core/constants.js";
import { flattenName } from "../core/naming.js";
import type { Dependent, DnsRecord } from "./types.js";

const lc = (s: string | undefined | null) => (s ?? "").toLowerCase();
/** Lowercase, no trailing dot: how CNAME targets are compared with record names. */
export const normName = (s: string | undefined | null) => lc(s).replace(/\.+$/, "");

export interface SiteHosts {
  /** Droplet name (lowercase). */
  site: string;
  /** Its site hostnames: the droplet name and the hostnames declared in its file. */
  hosts: string[];
  /** The droplet's public IPv4/IPv6 addresses. */
  publicIps: string[];
}

export interface DependentScan {
  dependents: Dependent[];
  /** "<zone wildcard>: ..." warnings, one per DNS-only wildcard that covers a site or dependent name. */
  wildcardWarnings: string[];
}

const isMarked = (r: DnsRecord) => (r.comment ?? "").startsWith(DNS_COMMENT_MARKER);
const isReserved = (h: string) => RESERVED_PREFIXES.some((p) => h.startsWith(p));
const chain = (via: string[], target: string) => [...via, target].join(" → ");

/**
 * `records`: every record of every readable zone. `zoneNames`: the account's zones.
 * `dropletNames`: every droplet's name (a dependent can never take another droplet's own name).
 */
export function findDependents(
  records: Array<{ zoneId: string; record: DnsRecord }>,
  sites: SiteHosts[],
  zoneNames: string[],
  dropletNames: Set<string>,
): DependentScan {
  // Site hostname -> droplet. A name claimed by two sites is a conflict reported elsewhere: no dependents.
  const owners = new Map<string, Set<string>>();
  for (const s of sites) for (const h of s.hosts) owners.set(h, (owners.get(h) ?? new Set()).add(s.site));
  const siteOf = (h: string) => {
    const o = owners.get(h);
    return o && o.size === 1 ? [...o][0] : undefined;
  };
  const siteByIp = new Map<string, string>();
  for (const s of sites) for (const ip of s.publicIps) siteByIp.set(lc(ip), s.site);

  const cnames = new Map<string, DnsRecord[]>();
  for (const { record: r } of records) {
    if (r.type === "CNAME") cnames.set(normName(r.name), [...(cnames.get(normName(r.name)) ?? []), r]);
  }

  /** Follows r's CNAME chain until it reaches a site hostname (or gives up). */
  const resolve = (r: DnsRecord): { target: string; via: string[] } | undefined => {
    const seen = new Set([normName(r.name)]);
    const via: string[] = [];
    let t = normName(r.content);
    for (let hop = 0; hop <= MAX_CNAME_CHAIN; hop++) {
      if (siteOf(t)) return { target: t, via };
      const next = cnames.get(t);
      if (!next || next.length !== 1 || seen.has(t) || hop === MAX_CNAME_CHAIN) return undefined;
      seen.add(t);
      via.push(t);
      t = normName(next[0]!.content);
    }
    return undefined;
  };

  const out: Dependent[] = [];
  for (const { zoneId, record: r } of records) {
    if (isMarked(r)) continue; // the tool's own records (tunnel CNAMEs, ssh-, vpc-)
    const name = normName(r.name);
    const base = { name, zoneId, type: r.type, content: normName(r.content), proxied: r.proxied === true };

    if (r.type === "CNAME") {
      const hit = resolve(r);
      if (!hit) continue;
      const site = siteOf(hit.target)!;
      const d = { ...base, site, target: hit.target, via: hit.via };
      const arrow = `${r.proxied ? "proxied" : "DNS-only"} CNAME → ${chain(hit.via, hit.target)}`;
      const nameSite = siteOf(name);
      if (!r.proxied) {
        out.push({
          ...d,
          kind: "dns-only",
          level: "error",
          detail: `${name} (${arrow}) is DNS-only: once ${hit.target} is a tunnel CNAME, ${name} resolves to Cloudflare but isn't proxied, so it stops working. Make it proxied (it then gets a tunnel route as an extra hostname of ${site}) or point it elsewhere before ${hit.target}'s cutover`,
        });
      } else if (owners.has(name)) {
        // A site hostname itself (declared in a droplet file): it has its own route.
        const other = nameSite && nameSite !== site ? nameSite : undefined;
        out.push({
          ...d,
          kind: "declared",
          level: other ? "warning" : "ok",
          detail: other
            ? `${name} (${arrow}) is declared under ${other}, so its route goes to ${other}'s origin, not to ${site}'s; check which site it belongs to`
            : `${name} (${arrow}) is a site hostname of ${nameSite ?? site} with its own route`,
        });
      } else {
        const f = flattenName(name, zoneNames);
        let why: string | undefined;
        let kind: Dependent["kind"] = "uncoverable";
        if (!f.ok) why = f.reason;
        else if (isReserved(name)) why = `names starting with ${RESERVED_PREFIXES.join(" or ")} are generated by the tool`;
        else if (dropletNames.has(name)) why = "it is another droplet's own name";
        else if (name.slice(0, name.length - f.zone.length - 1).includes(".")) {
          kind = "multi-level";
          why = `it is more than one level under ${f.zone}, and the free certificate only covers *.${f.zone}, so it can't get a tunnel route`;
        }
        if (why) {
          out.push({
            ...d,
            kind,
            level: "error",
            detail: `${name} (${arrow}) can't be served through ${site}'s tunnel route: ${why}. Rename it, remove it or point it elsewhere before ${hit.target}'s cutover`,
          });
        } else {
          out.push({
            ...d,
            kind: "implicit",
            level: "ok",
            detail: `${name} (${arrow}) is served as an extra hostname of ${site} (same origin)`,
          });
        }
      }
      continue;
    }

    if (r.type === "A" || r.type === "AAAA") {
      const site = siteByIp.get(lc(r.content));
      if (!site || siteOf(name) === site) continue; // the site's own names are covered (or awaiting cutover)
      out.push({
        ...base,
        site,
        target: site,
        via: [],
        kind: "direct-ip",
        level: "warning",
        detail: `${name} (${r.type} ${r.content}${r.proxied ? ", proxied" : ""}) goes straight to ${site}'s public IP (direct to origin); it breaks when Phase 5 closes the origin ports. Add it to ${site}'s web.hostnames`,
      });
    }
  }
  out.sort((a, b) => a.site.localeCompare(b.site) || a.name.localeCompare(b.name));

  // DNS-only wildcards: during any moment with no specific record, they answer for the site's names.
  const watched = new Set<string>([...owners.keys(), ...out.map((d) => d.name)]);
  const wildcardWarnings: string[] = [];
  for (const { record: r } of records) {
    const name = normName(r.name);
    if (!name.startsWith("*.") || r.proxied || isMarked(r) || !["A", "AAAA", "CNAME"].includes(r.type)) continue;
    const suffix = name.slice(1); // ".example.com"
    const hit = [...watched].filter((h) => h.endsWith(suffix)).sort();
    if (!hit.length) continue;
    const shown = hit.length > 5 ? `${hit.slice(0, 5).join(", ")} and ${hit.length - 5} more` : hit.join(", ");
    wildcardWarnings.push(
      `${name}: DNS-only wildcard (${r.type} ${normName(r.content)}) in a zone with site or dependent names (${shown}); whenever one of them has no record of its own, the wildcard answers for it. Only swap records in place (cutover), never delete-then-create`,
    );
  }
  return { dependents: out, wildcardWarnings };
}
