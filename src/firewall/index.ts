// B3: firewall plan, REPORT-ONLY until migration Phase 5. See README.md in this folder.
//
// firewallRules derives the inbound rules the droplet files imply; planFirewall compares them
// with today's DigitalOcean firewalls and shows, per droplet, what Phase 5 would add, narrow or
// remove. Every op is a `report` op: nothing here ever writes a firewall.

import { KNOWN_AFTER_CREATE } from "../core/constants.js";
import type { DesiredDroplet, DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import { ApiClient } from "../core/http.js";
import type { ObservedDroplet } from "../core/observed.js";
import type { ApplyResult, Json, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";
import { parseCidr, ValueError } from "../core/values.js";

/** A DigitalOcean cloud firewall as read from GET /v2/firewalls (fields B3 needs). */
export interface DoFirewall {
  id: string;
  name: string;
  status?: string;
  droplet_ids: number[];
  tags: string[];
  inbound_rules: Array<{
    protocol: "tcp" | "udp" | "icmp";
    /** "8443", "8000-8010", "all" or "0" (icmp). */
    ports: string;
    sources: { addresses?: string[]; droplet_ids?: number[]; tags?: string[]; load_balancer_uids?: string[] };
  }>;
  outbound_rules: Array<{
    protocol: "tcp" | "udp" | "icmp";
    ports: string;
    destinations: { addresses?: string[]; droplet_ids?: number[]; tags?: string[]; load_balancer_uids?: string[] };
  }>;
}

export interface FirewallObserved {
  firewalls: DoFirewall[];
}

/** Where a desired rule comes from in the droplet file. */
export type RuleOrigin = "allow.droplet" | "allow.ip" | "swarm";

/** One inbound rule a droplet file implies, before it is mapped onto DigitalOcean firewalls. */
export interface DesiredFirewallRule {
  /** The callee: the droplet whose file declares the rule. */
  droplet: string;
  protocol: "tcp" | "udp";
  /** "8443" or "8000-8010". */
  ports: string;
  /** The caller. */
  source:
    | { kind: "droplet"; name: string; address: string; addressKind: "private" | "public" }
    | { kind: "address"; cidr: string };
  origin: RuleOrigin;
  /** allow.droplet across regions (no VPC peering): public IP used; flagged in the PR comment. */
  crossRegion?: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------------------------
// firewallRules
// ---------------------------------------------------------------------------------------------

/** Docker Swarm ports (decision 13): 2377/tcp to managers; 7946/tcp+udp and 4789/udp between all members. */
const SWARM_MANAGER_PORTS: ReadonlyArray<["tcp" | "udp", string]> = [["tcp", "2377"]];
const SWARM_MEMBER_PORTS: ReadonlyArray<["tcp" | "udp", string]> = [
  ["tcp", "7946"],
  ["udp", "7946"],
  ["udp", "4789"],
];

/** Droplets a rule can be attached to or come from: they exist, or apply creates them. */
const placed = (d: DesiredDroplet): boolean => d.status === "exists" || d.status === "create";

/** The address a caller reaches a callee from: private in the same region, public across regions. */
function callerAddress(callee: DesiredDroplet, caller: DesiredDroplet): { address: string; addressKind: "private" | "public"; crossRegion: boolean } {
  if (!callee.region || !caller.region) return { address: KNOWN_AFTER_CREATE, addressKind: "private", crossRegion: false };
  if (callee.region === caller.region) return { address: caller.privateIpv4 ?? KNOWN_AFTER_CREATE, addressKind: "private", crossRegion: false };
  return { address: caller.publicIpv4 ?? KNOWN_AFTER_CREATE, addressKind: "public", crossRegion: true };
}

/** How a rule's source is written in keys and messages: a CIDR, or the caller's name while its IP is unknown. */
export function sourceText(s: DesiredFirewallRule["source"]): string {
  if (s.kind === "address") return s.cidr;
  return s.address === KNOWN_AFTER_CREATE ? `${s.name} ${s.addressKind} IP ${KNOWN_AFTER_CREATE}` : toCidr(s.address);
}

const ruleKey = (r: DesiredFirewallRule): string => `${r.droplet} inbound ${r.protocol}/${r.ports} ${sourceText(r.source)}`;

/**
 * Pure: every inbound rule implied by allow.droplet, allow.ip and swarm (all-pairs: 2377/tcp to
 * managers, 7946/tcp+udp and 4789/udp between members). ESP (protocol 50, encrypted overlay) can't
 * be expressed in a DigitalOcean firewall: a warning diagnostic per cluster, no rule.
 * Same region -> caller's private IP; different region -> public IP and crossRegion: true.
 * Never throws: callers without a droplet file, and droplets that are missing or conflicting, are
 * skipped (the checks and the desired state report them). Duplicates (swarm and allow.droplet
 * implying the same rule) are kept once, the first one found.
 */
export function firewallRules(desired: DesiredState): { rules: DesiredFirewallRule[]; diagnostics: ModulePlan["diagnostics"] } {
  const rules: DesiredFirewallRule[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const add = (r: DesiredFirewallRule) => {
    const k = ruleKey(r);
    if (seen.has(k)) return;
    seen.add(k);
    rules.push(r);
  };
  const byName = new Map(desired.droplets.map((d) => [d.name, d]));

  for (const callee of desired.droplets.filter(placed)) {
    for (const a of callee.spec.allow.droplet) {
      const caller = byName.get(a.from);
      if (!caller || !placed(caller)) continue;
      const { address, addressKind, crossRegion } = callerAddress(callee, caller);
      for (const p of a.ports) {
        add({
          droplet: callee.name,
          protocol: p.protocol,
          ports: portsOf(p.from, p.to),
          source: { kind: "droplet", name: caller.name, address, addressKind },
          origin: "allow.droplet",
          ...(crossRegion ? { crossRegion: true } : {}),
          ...(a.note ? { note: a.note } : {}),
        });
      }
    }
    for (const x of callee.spec.allow.ip) {
      for (const p of x.ports) {
        add({
          droplet: callee.name,
          protocol: p.protocol,
          ports: portsOf(p.from, p.to),
          source: { kind: "address", cidr: x.from },
          origin: "allow.ip",
          ...(x.note ? { note: x.note } : {}),
        });
      }
    }
  }

  const clusters = new Map<string, DesiredDroplet[]>();
  for (const d of desired.droplets.filter(placed)) {
    if (d.spec.swarm) clusters.set(d.spec.swarm.cluster, [...(clusters.get(d.spec.swarm.cluster) ?? []), d]);
  }
  for (const [cluster, members] of [...clusters.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const encrypted = members.filter((m) => m.spec.swarm!.encrypted_overlay);
    if (encrypted.length) {
      const first = encrypted[0]!;
      diagnostics.push({
        level: "warning",
        code: "swarm-esp",
        file: first.source,
        path: "swarm.encrypted_overlay",
        droplet: first.name,
        message:
          `swarm cluster "${cluster}" uses an encrypted overlay, which needs ESP (IP protocol 50) between members. ` +
          "A DigitalOcean cloud firewall can only allow tcp, udp and icmp, so ESP can't be expressed and no rule is planned for it",
      });
    }
    for (const callee of members) {
      const ports = [...(callee.spec.swarm!.role === "manager" ? SWARM_MANAGER_PORTS : []), ...SWARM_MEMBER_PORTS];
      for (const peer of members) {
        if (peer === callee) continue;
        const { address, addressKind, crossRegion } = callerAddress(callee, peer);
        for (const [protocol, port] of ports) {
          add({
            droplet: callee.name,
            protocol,
            ports: port,
            source: { kind: "droplet", name: peer.name, address, addressKind },
            origin: "swarm",
            ...(crossRegion ? { crossRegion: true } : {}),
          });
        }
      }
    }
  }
  return { rules, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// planFirewall
// ---------------------------------------------------------------------------------------------

interface Range {
  from: number;
  to: number;
}

const portsOf = (from: number, to: number): string => (from === to ? `${from}` : `${from}-${to}`);

/** DigitalOcean ports: "8443", "8000-8010", or "all" / "0" / "" for every port. undefined if unreadable. */
export function parseDoPorts(ports: string | undefined): Range | undefined {
  const p = (ports ?? "").trim().toLowerCase();
  if (p === "" || p === "all" || p === "0") return { from: 1, to: 65535 };
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return from >= 1 && to <= 65535 && from <= to ? { from, to } : undefined;
}

const rangeText = (r: Range): string => (r.from === 1 && r.to === 65535 ? "all" : portsOf(r.from, r.to));

function toCidr(a: string): string {
  try {
    return parseCidr(a);
  } catch (e) {
    if (e instanceof ValueError) return a.trim().toLowerCase();
    throw e;
  }
}

function v4ToInt(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  return m.slice(1).reduce((n, o) => n * 256 + Number(o), 0);
}

/** outer contains inner (both normalised CIDRs). IPv4 exactly; IPv6 only ::/0 or equality. */
export function cidrContains(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const [oip = "", obits = ""] = outer.split("/");
  const [iip = "", ibits = ""] = inner.split("/");
  const o = v4ToInt(oip);
  const i = v4ToInt(iip);
  if (o !== undefined && i !== undefined) {
    const ob = Number(obits);
    if (Number(ibits) < ob) return false;
    if (ob === 0) return true;
    const mask = (0xffffffff << (32 - ob)) >>> 0;
    return ((o & mask) >>> 0) === ((i & mask) >>> 0);
  }
  return outer === "::/0" && iip.includes(":");
}

/** One source of one inbound rule of one firewall, as it applies to one droplet today. */
interface Atom {
  firewall: DoFirewall;
  /** How the firewall reaches this droplet: "droplet id" or "tag <t>". */
  attachedBy: string;
  protocol: "tcp" | "udp";
  range: Range;
  source:
    | { kind: "address"; cidr: string }
    | { kind: "droplet"; id: number; name?: string }
    | { kind: "tag"; tag: string; members: string[] }
    | { kind: "load-balancer"; uid: string };
}

function atomSourceText(s: Atom["source"]): string {
  switch (s.kind) {
    case "address":
      return s.cidr;
    case "droplet":
      return `droplet:${s.name ?? s.id}`;
    case "tag":
      return `tag:${s.tag}`;
    case "load-balancer":
      return `load-balancer:${s.uid}`;
  }
}

const atomKey = (a: Atom, droplet: string): string =>
  `${a.firewall.name} inbound ${a.protocol}/${rangeText(a.range)} ${atomSourceText(a.source)} on ${droplet}`;

const atomJson = (a: Atom): Json => ({
  firewall: a.firewall.name,
  attached_by: a.attachedBy,
  protocol: a.protocol,
  ports: rangeText(a.range),
  source: atomSourceText(a.source),
  ...(a.source.kind === "tag" ? { tag_members: a.source.members } : {}),
});

const ruleJson = (r: DesiredFirewallRule): Json => ({
  protocol: r.protocol,
  ports: r.ports,
  source: sourceText(r.source),
  ...(r.source.kind === "droplet" ? { caller: r.source.name, address_kind: r.source.addressKind } : {}),
  ...(r.crossRegion ? { cross_region: true } : {}),
});

const sameRange = (a: Range, b: Range): boolean => a.from === b.from && a.to === b.to;
const containsRange = (outer: Range, inner: Range): boolean => outer.from <= inner.from && inner.to <= outer.to;

export function planFirewall(desired: DesiredState, observed: FirewallObserved): ModulePlan {
  const { rules, diagnostics } = firewallRules(desired);
  const ops: PlanOp[] = [];
  let unchanged = 0;

  // Every droplet DigitalOcean has, to resolve droplet_ids and tags in today's rules.
  const known: ObservedDroplet[] = [...desired.droplets.flatMap((d) => (d.observed ? [d.observed] : [])), ...desired.unmanaged];
  const nameById = new Map(known.map((d) => [d.id, d.name]));
  const byName = new Map(desired.droplets.map((d) => [d.name, d]));
  const tagsOf = (d: DesiredDroplet): string[] => d.observed?.tags ?? d.tags;
  const membersOf = (tag: string): string[] => [...new Set(known.filter((d) => d.tags.includes(tag)).map((d) => d.name))].sort();
  const unreadable = new Set<string>();

  const atomsFor = (d: DesiredDroplet): Atom[] => {
    const tags = tagsOf(d);
    const atoms: Atom[] = [];
    const fws = [...observed.firewalls].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    for (const fw of fws) {
      const byId = d.observed !== undefined && fw.droplet_ids.includes(d.observed.id);
      const byTag = fw.tags.filter((t) => tags.includes(t)).sort();
      if (!byId && !byTag.length) continue;
      const attachedBy = byId ? "droplet id" : `tag ${byTag[0]}`;
      for (const rule of fw.inbound_rules) {
        if (rule.protocol !== "tcp" && rule.protocol !== "udp") continue; // icmp: not modelled by the files, left alone
        const range = parseDoPorts(rule.ports);
        if (!range) {
          unreadable.add(`${fw.name} ${rule.protocol}/${rule.ports}`);
          continue;
        }
        const base = { firewall: fw, attachedBy, protocol: rule.protocol, range };
        const s = rule.sources ?? {};
        for (const a of s.addresses ?? []) atoms.push({ ...base, source: { kind: "address", cidr: toCidr(a) } });
        for (const id of s.droplet_ids ?? []) {
          const name = nameById.get(id);
          atoms.push({ ...base, source: { kind: "droplet", id, ...(name ? { name } : {}) } });
        }
        for (const tag of s.tags ?? []) atoms.push({ ...base, source: { kind: "tag", tag, members: membersOf(tag) } });
        for (const uid of s.load_balancer_uids ?? []) atoms.push({ ...base, source: { kind: "load-balancer", uid } });
      }
    }
    // The same source can be listed by two firewalls; each is shown, but the same atom only once.
    const seen = new Set<string>();
    return atoms.filter((a) => {
      const k = atomKey(a, d.name);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const callerOf = (r: DesiredFirewallRule): DesiredDroplet | undefined => (r.source.kind === "droplet" ? byName.get(r.source.name) : undefined);
  const ruleCidr = (r: DesiredFirewallRule): string | undefined =>
    r.source.kind === "address" ? r.source.cidr : r.source.address === KNOWN_AFTER_CREATE ? undefined : toCidr(r.source.address);

  /** The atom grants exactly this rule: same protocol and ports; same address, or the caller's own droplet id. */
  const exact = (a: Atom, r: DesiredFirewallRule, range: Range): boolean => {
    if (a.protocol !== r.protocol || !sameRange(a.range, range)) return false;
    const cidr = ruleCidr(r);
    if (a.source.kind === "address") return cidr !== undefined && a.source.cidr === cidr;
    // Assumed (not confirmed in DigitalOcean's docs): a droplet source admits all that droplet's addresses,
    // so it is the same access as the caller's IP rule.
    if (a.source.kind === "droplet") return callerOf(r)?.observed?.id === a.source.id;
    return false;
  };
  /** The atom grants this rule and possibly more (wider ports or sources). */
  const covers = (a: Atom, r: DesiredFirewallRule, range: Range): boolean => {
    if (a.protocol !== r.protocol || !containsRange(a.range, range)) return false;
    const cidr = ruleCidr(r);
    const caller = callerOf(r);
    switch (a.source.kind) {
      case "address":
        return cidr !== undefined ? cidrContains(a.source.cidr, cidr) : a.source.cidr === "0.0.0.0/0";
      case "droplet":
        return caller?.observed?.id === a.source.id;
      case "tag":
        return caller !== undefined && tagsOf(caller).includes(a.source.tag);
      case "load-balancer":
        return false;
    }
  };

  for (const d of desired.droplets.filter(placed)) {
    const mine = rules.filter((r) => r.droplet === d.name);
    const atoms = atomsFor(d);
    const kept = new Set<Atom>();
    const narrowedTo = new Map<Atom, DesiredFirewallRule[]>();
    const pending = d.status === "create";
    const rangeOf = (r: DesiredFirewallRule): Range => parseDoPorts(r.ports)!;

    const unmatched: DesiredFirewallRule[] = [];
    for (const r of mine) {
      const hits = atoms.filter((a) => exact(a, r, rangeOf(r)));
      if (hits.length) {
        hits.forEach((a) => kept.add(a));
        unchanged++;
      } else unmatched.push(r);
    }
    for (const r of unmatched) {
      const wider = atoms.filter((a) => covers(a, r, rangeOf(r)));
      if (wider.some((a) => kept.has(a))) {
        unchanged++; // already granted by a rule that stays
        continue;
      }
      if (wider.length) {
        for (const a of wider) narrowedTo.set(a, [...(narrowedTo.get(a) ?? []), r]);
        continue;
      }
      ops.push({
        provider: "digitalocean",
        module: "firewall",
        kind: "firewall-rule",
        key: ruleKey(r),
        action: "report",
        before: null,
        after: ruleJson(r),
        reason: `would allow ${r.protocol}/${r.ports} from ${describeRule(r, d)} (not allowed today)`,
        droplet: d.name,
        ...(pending || ruleCidr(r) === undefined ? { pending: true } : {}),
      });
    }
    for (const a of atoms) {
      if (kept.has(a)) continue;
      const to = narrowedTo.get(a);
      const today = `today firewall ${a.firewall.name} (attached by ${a.attachedBy}) allows ${a.protocol}/${rangeText(a.range)} from ${describeAtom(a)}`;
      ops.push({
        provider: "digitalocean",
        module: "firewall",
        kind: "firewall-rule",
        key: atomKey(a, d.name),
        action: "report",
        before: atomJson(a),
        after: to ? to.map(ruleJson) : null,
        reason: to
          ? `would narrow: ${today}; the droplet files only ask for ${to.map((r) => `${r.protocol}/${r.ports} from ${describeRule(r, d)}`).join("; ")}`
          : `would remove: ${today}, which no droplet file declares`,
        droplet: d.name,
        ...(pending ? { pending: true } : {}),
      });
    }
  }

  if (ops.some((o) => o.before !== null && o.after === null)) {
    diagnostics.push({
      level: "info",
      code: "firewall-undeclared",
      message:
        "The firewall plan is report-only. Rules that no droplet file declares are shown as \"would remove\". " +
        "That includes access the files can't declare yet, such as the tunnel connectors reaching SSH, web origins and allow.tunnel ports. " +
        "Phase 5 must account for those before closing anything",
    });
  }
  for (const u of [...unreadable].sort()) {
    diagnostics.push({ level: "warning", code: "firewall-unreadable-rule", message: `firewall rule ${u} has ports the tool can't read; it is left out of the plan` });
  }
  return { module: "firewall", ops, unchanged, diagnostics };
}

function describeRule(r: DesiredFirewallRule, callee: DesiredDroplet): string {
  const note = r.note ? ` "${r.note}"` : "";
  if (r.source.kind === "address") return `${r.source.cidr} (allow.ip${note})`;
  const ip = r.source.address === KNOWN_AFTER_CREATE ? `${r.source.addressKind} IP ${KNOWN_AFTER_CREATE}` : `${r.source.addressKind} IP ${r.source.address}`;
  const why = r.origin === "swarm" ? `swarm cluster ${callee.spec.swarm?.cluster ?? ""}`.trim() : `allow.droplet${note}`;
  const flag = r.crossRegion ? "; other region, no VPC peering, so the caller's PUBLIC IP" : "";
  return `${r.source.name} ${ip} (${why}${flag})`;
}

function describeAtom(a: Atom): string {
  switch (a.source.kind) {
    case "address":
      return a.source.cidr === "0.0.0.0/0" || a.source.cidr === "::/0" ? `${a.source.cidr} (anywhere)` : a.source.cidr;
    case "droplet":
      return `droplet ${a.source.name ?? `id ${a.source.id}`}`;
    case "tag":
      return `tag ${a.source.tag} (${a.source.members.length ? a.source.members.join(", ") : "no droplets"})`;
    case "load-balancer":
      return `load balancer ${a.source.uid}`;
  }
}

// ---------------------------------------------------------------------------------------------
// observe and apply
// ---------------------------------------------------------------------------------------------

export const DO_API = "https://api.digitalocean.com";
const PER_PAGE = 200;
const MAX_PAGES = 50;

interface FirewallsPage {
  firewalls?: unknown[];
  links?: { pages?: { next?: string } };
}

function toFirewall(raw: unknown): DoFirewall {
  const f = (raw ?? {}) as Partial<DoFirewall>;
  return {
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    ...(f.status !== undefined ? { status: f.status } : {}),
    droplet_ids: Array.isArray(f.droplet_ids) ? f.droplet_ids : [],
    tags: Array.isArray(f.tags) ? f.tags : [],
    inbound_rules: Array.isArray(f.inbound_rules) ? f.inbound_rules.map((r) => ({ ...r, sources: r.sources ?? {} })) : [],
    outbound_rules: Array.isArray(f.outbound_rules) ? f.outbound_rules.map((r) => ({ ...r, destinations: r.destinations ?? {} })) : [],
  };
}

/** Read-only: GET /v2/firewalls (all pages). The client never writes, even in apply. */
export async function observeFirewalls(ctx: RunContext): Promise<FirewallObserved> {
  const client = new ApiClient({
    baseUrl: DO_API,
    headers: { Authorization: `Bearer ${ctx.secrets.require("DO_TOKEN")}` },
    fetch: ctx.fetch,
    allowWrites: false,
    name: "digitalocean",
  });
  const firewalls: DoFirewall[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await client.get<FirewallsPage>("/v2/firewalls", { page, per_page: PER_PAGE });
    firewalls.push(...(body.firewalls ?? []).map(toFirewall));
    if (!body.links?.pages?.next) return { firewalls };
  }
  throw new Error(`digitalocean GET /v2/firewalls: more than ${MAX_PAGES} pages`);
}

/** Report-only: performs nothing. Returns every op as skipped; throws if handed a non-report op. */
export async function applyFirewall(ops: PlanOp[]): Promise<ApplyResult> {
  const bad = ops.find((o) => o.action !== "report");
  if (bad) throw new Error(`firewall is report-only until migration Phase 5; refusing ${bad.action} ${bad.key}`);
  return { module: "firewall", applied: [], failed: [], skipped: ops.map((op) => ({ op, reason: "report-only" })) };
}

export function createFirewallProvider(ctx: RunContext): Provider<FirewallObserved> {
  return {
    module: "firewall",
    observe: () => observeFirewalls(ctx),
    diff: (desired, observed) => planFirewall(desired, observed),
    apply: (ops) => applyFirewall(ops),
  };
}
