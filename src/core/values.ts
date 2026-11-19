// Pure parsers for values inside droplet files: ports, CIDRs, paths, `who` entries.
// Each throws ValueError with a message that names what was wrong (never the file:
// the loader adds the file and path).

import type { PortSpec, Who, WhoEntry } from "./model.js";

export class ValueError extends Error {}

const PORT_RE = /^(\d{1,5})(?:-(\d{1,5}))?\/(tcp|udp)$/;

/** "8443/tcp", "5000/udp", "8000-8010/tcp". */
export function parsePort(v: string): PortSpec {
  const m = PORT_RE.exec(v);
  if (!m) throw new ValueError(`"${v}" is not a port such as "8443/tcp" or "8000-8010/udp"`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  if (from < 1 || from > 65535 || to < 1 || to > 65535) throw new ValueError(`"${v}": ports are 1-65535`);
  if (to < from) throw new ValueError(`"${v}": range end is below its start`);
  return { from, to, protocol: m[3] as PortSpec["protocol"], raw: v };
}

export const formatPort = (p: PortSpec): string => (p.from === p.to ? `${p.from}/${p.protocol}` : `${p.from}-${p.to}/${p.protocol}`);

/** IPv4/IPv6 address or CIDR; a bare address becomes /32 or /128. Ported from infra-sync parseCidr. */
export function parseCidr(v: string): string {
  const bad = () => new ValueError(`must be an IP address or CIDR, got ${JSON.stringify(v)}`);
  const [ip = "", prefix, ...rest] = v.trim().split("/");
  if (rest.length) throw bad();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    if (v4.slice(1).some((o) => Number(o) > 255)) throw bad();
    const n = prefix === undefined ? 32 : Number(prefix);
    if (!/^\d{1,2}$/.test(prefix ?? "32") || n > 32) throw bad();
    return `${ip}/${n}`;
  }
  if (ip.includes(":") && /^[0-9a-f:]+$/i.test(ip) && ip.length <= 39) {
    const n = prefix === undefined ? 128 : Number(prefix);
    if (!/^\d{1,3}$/.test(prefix ?? "128") || n > 128) throw bad();
    return `${ip.toLowerCase()}/${n}`;
  }
  throw bad();
}

/** Lowercase, no trailing slash: how Access destinations and paths are compared. */
export const normPath = (p: string): string => p.toLowerCase().replace(/\/+$/, "");

/** `staff` | `service-token:<name>`. */
export function parseWho(v: string): Who {
  if (v === "staff") return { kind: "staff" };
  const m = /^service-token:([a-z0-9][a-z0-9_-]*)$/.exec(v);
  if (m) return { kind: "service-token", name: m[1]! };
  throw new ValueError(`"${v}" must be "staff" or "service-token:<name>"`);
}

export const formatWho = (w: Who): string => (w.kind === "staff" ? "staff" : `service-token:${w.name}`);

// ---------- who-lists (ssh:, web.access) ----------

const GROUP_RE = /^[a-z][a-z0-9-]*$/;
const EMAIL_RE = /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const TOKEN_RE = /^token:([a-z0-9][a-z0-9_-]*)$/;

/**
 * One who-list entry: `staff`, `everyone`, `token:<name>`, `ip:<address or CIDR>`, an email
 * address or a group name. Throws ValueError for anything else. References (does the group or
 * token exist, is the email in the domain) are checked in src/checks.
 */
export function parseWhoEntry(v: string): WhoEntry {
  if (v === "staff") return { kind: "staff" };
  if (v === "everyone") return { kind: "everyone" };
  const t = TOKEN_RE.exec(v);
  if (t) return { kind: "token", name: t[1]! };
  if (v.startsWith("ip:")) return { kind: "ip", cidr: parseCidr(v.slice(3)) };
  if (v.includes("@")) {
    if (!EMAIL_RE.test(v)) throw new ValueError(`"${v}" is not an email address`);
    return { kind: "email", email: v.toLowerCase() };
  }
  if (GROUP_RE.test(v)) return { kind: "group", name: v };
  throw new ValueError(`"${v}" must be a group name, an email, staff, everyone, token:<name> or ip:<address>`);
}

/** The entry as written in a file (an ip: entry with its normalised CIDR). */
export function formatWhoEntry(w: WhoEntry): string {
  switch (w.kind) {
    case "group":
      return w.name;
    case "email":
      return w.email;
    case "token":
      return `token:${w.name}`;
    case "ip":
      return `ip:${w.cidr}`;
    default:
      return w.kind;
  }
}

/** Entries that need a person to log in (staff, a group, an email). */
export const isPersonEntry = (w: WhoEntry): boolean => w.kind === "staff" || w.kind === "group" || w.kind === "email";

/** Parses a list, skipping entries that don't parse (the loader reports them). */
export function parseWhoList(list: readonly string[]): WhoEntry[] {
  const out: WhoEntry[] = [];
  for (const v of list) {
    try {
      out.push(parseWhoEntry(v));
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
    }
  }
  return out;
}
