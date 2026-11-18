// Pure parsers for values inside droplet files: ports, CIDRs, paths, `who` entries.
// Each throws ValueError with a message that names what was wrong (never the file:
// the loader adds the file and path).

import type { PortSpec, Who } from "./model.js";

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
