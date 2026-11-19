// Desired state: the droplet files joined with the droplets that exist now, with every
// default applied. This is the one input every module plans from, so they all agree on
// names, defaults and which droplets are new.
//
// Pure. The engine builds it after the droplets module has observed DigitalOcean, and
// builds it again during apply once new droplets are up (then they have IPs).

import { DEFAULT_HEALTH_PATH, DEFAULT_HEALTH_PATH_DEPLOY, DEFAULT_WEB_ORIGIN, FIREWALL_TAGS, HEALTH_BYPASS_PATH } from "./constants.js";
import type { Diagnostic } from "./diagnostics.js";
import type { AccountConfig, DropletFile, EnvName, InfraConfig, Profile, WhoEntry } from "./model.js";
import { flattenName } from "./naming.js";
import type { ObservedDroplet } from "./observed.js";
import { isPersonEntry, normPath, parseWhoList } from "./values.js";

/**
 * - exists:   a droplet with this name exists; the file manages it (adopted or created earlier)
 * - create:   no droplet yet and the file has a profile; apply creates it
 * - missing:  no droplet and no profile; an error (nothing to manage, nothing to create)
 * - conflict: several droplets have this name; none of them is managed (as the Worker does)
 */
export type DropletStatus = "exists" | "create" | "missing" | "conflict";

/** One web.access rule with its who-list parsed. */
export interface DesiredAccess {
  /** As written ("/", "/admin", "/healthcheck/"): Access app names embed it. */
  path: string;
  /** Lowercase, no trailing slash ("" for the root): how Access compares paths. */
  norm: string;
  who: WhoEntry[];
  /** Exactly [everyone]: open without a login. */
  everyone: boolean;
  /** Has an entry a person logs in as (staff, a group, an email). */
  needsLogin: boolean;
}

export interface DesiredWeb {
  /** Origin with the default applied; {ip} still unresolved. */
  origin: string;
  /** Every site hostname: the droplet name first, then the extra hostnames in file order. */
  hostnames: string[];
  extraHostnames: string[];
  /** web.access in file order (the root "/" among them). */
  access: DesiredAccess[];
  /** "/" is [everyone]: no Access app on the root, and paths that need a login answer 404 on extra hostnames. */
  rootOpen: boolean;
  /** web.access opens /healthcheck/ to everyone: the public healthcheck app on the droplet's own name. */
  publicHealthcheck: boolean;
  healthPath: string;
  healthAcceptApp404: boolean;
}

export interface DesiredMonitor {
  type: "http";
  hostname: string;
  path: string;
  acceptApp404: boolean;
}

export interface DesiredDroplet {
  name: string;
  /** droplets/<name>.yaml */
  source: string;
  spec: DropletFile;
  status: DropletStatus;
  /** The droplet as it is now (status exists). */
  observed?: ObservedDroplet;
  /** status create: the profile to create it from. */
  profile?: Profile;

  // ---------- names (undefined when the name is not in an account zone; src/checks reports it) ----------
  zone?: string;
  /** Flattened label. */
  label?: string;
  /** SSH route ssh-<label>.<zone>. */
  sshHostname?: string;
  /** Private name vpc-<label>.<zone>. */
  vpcHostname?: string;
  /** Why the name has no generated names, when it has none. */
  namingError?: string;

  // ---------- placement ----------
  /** Observed region, or for status create the region of its env. */
  region?: string;
  /** Tunnel of that region; undefined: no tunnel there, so no Cloudflare side. */
  tunnelId?: string;
  /** undefined for status create (KNOWN_AFTER_CREATE in plans) and for a droplet with no private IP yet. */
  privateIpv4?: string;
  publicIpv4?: string;

  // ---------- what the file asks for, defaults applied ----------
  env?: EnvName;
  frozen: boolean;
  /**
   * DigitalOcean tags the droplet is created with (status create only matters): the old firewall
   * tag of its env (decision 20). The tool never writes tags on an existing droplet.
   */
  tags: string[];
  /**
   * The people in the SSH access list: groups expanded, emails lowercased, deduplicated, sorted. Who
   * may SSH into the droplet, always as ubuntu. An unknown group adds nothing (src/checks reports it).
   */
  sshEmails: string[];
  /** The ssh list has `staff`: anyone with an address in account.yaml email_domain. */
  sshStaff: boolean;
  /** Service-token names in the ssh list (`token:<name>`), deduplicated, sorted: Service Auth on the ssh- app only. */
  sshTokens: string[];
  web?: DesiredWeb;
  monitors: DesiredMonitor[];
}

export interface DesiredState {
  account: AccountConfig;
  profiles: Record<string, Profile>;
  /** One per droplet file, sorted by name. */
  droplets: DesiredDroplet[];
  /** Droplets that exist but have no file: reported, never touched. */
  unmanaged: ObservedDroplet[];
  diagnostics: Diagnostic[];
}

/** The tags a droplet the tool creates gets: the old firewall tag of its env (decision 20). */
export function desiredTags(spec: DropletFile): string[] {
  return spec.env ? [FIREWALL_TAGS[spec.env]] : [];
}

/** People in a who-list: groups expanded, emails lowercased, deduplicated, sorted. */
export function resolvePeople(account: AccountConfig, who: readonly WhoEntry[]): string[] {
  const out = new Set<string>();
  for (const w of who) {
    if (w.kind === "email") out.add(w.email.toLowerCase());
    else if (w.kind === "group" && Object.hasOwn(account.groups, w.name)) for (const e of account.groups[w.name]!) out.add(e.toLowerCase());
  }
  return [...out].sort();
}

/** A droplet's ssh list with its groups expanded: lowercase emails, deduplicated, sorted. */
export function resolveSshAccess(account: AccountConfig, ssh: readonly string[]): string[] {
  return resolvePeople(account, parseWhoList(ssh));
}

/** Service-token names in a who-list, deduplicated, sorted. */
export const tokenNames = (who: readonly WhoEntry[]): string[] =>
  [...new Set(who.flatMap((w) => (w.kind === "token" ? [w.name] : [])))].sort();

const HEALTH_NORM = `/${HEALTH_BYPASS_PATH}`;

export function desiredWeb(spec: DropletFile): DesiredWeb | undefined {
  const w = spec.web;
  if (!w) return undefined;
  const access: DesiredAccess[] = w.access.map((r) => {
    const who = parseWhoList(r.who);
    return {
      path: r.path,
      norm: normPath(r.path),
      who,
      everyone: who.length === 1 && who[0]!.kind === "everyone",
      needsLogin: who.some(isPersonEntry),
    };
  });
  const root = access.find((a) => a.norm === "");
  const publicHealthcheck = access.some((a) => a.norm === HEALTH_NORM && a.everyone);
  return {
    origin: w.origin ?? DEFAULT_WEB_ORIGIN,
    hostnames: [spec.name, ...w.hostnames],
    extraHostnames: [...w.hostnames],
    access,
    rootOpen: !!root?.everyone,
    publicHealthcheck,
    healthPath: w.health_path ?? (publicHealthcheck ? DEFAULT_HEALTH_PATH_DEPLOY : DEFAULT_HEALTH_PATH),
    healthAcceptApp404: w.health_accept_app_404,
  };
}

/** True when `norm` (a normalised path) is `base` or under it, segment by segment ("" covers everything). */
export const pathUnder = (norm: string, base: string): boolean => base === "" || norm === base || norm.startsWith(`${base}/`);

/**
 * The rule Access applies to a path on one of the site's hostnames: the most specific web.access
 * path that covers it (segment by segment, case-insensitive), with the extra-hostname rules:
 *  - "404": on an extra hostname of a site whose root is open to everyone, the path is under one that
 *    needs a login: the tunnel answers 404 (its rule covers everything under that path);
 *  - /healthcheck/ open to everyone counts only on the droplet's own name (elsewhere its parent applies).
 */
export function accessFor(web: DesiredWeb, path: string, onBase: boolean): DesiredAccess | "404" {
  const n = normPath(path.split("?")[0]!);
  let best: DesiredAccess | undefined;
  for (const a of web.access) {
    if (!pathUnder(n, a.norm)) continue;
    if (!onBase && a.norm === HEALTH_NORM && a.everyone) continue;
    if (!best || a.norm.length > best.norm.length) best = a;
  }
  const rule = best!; // "/" is always there (the loader requires it)
  // On an extra hostname of a site open to everyone at "/", every path that needs a login is a 404
  // rule in the tunnel, which covers everything under it (an open path under it included).
  if (!onBase && web.rootOpen && web.access.some((a) => a.norm !== "" && a.needsLogin && pathUnder(n, a.norm))) return "404";
  return rule;
}

/** Explicit monitors with defaults from web, or one per site hostname when the file sets none. */
export function desiredMonitors(spec: DropletFile, web: DesiredWeb | undefined): DesiredMonitor[] {
  const healthPath = web?.healthPath ?? DEFAULT_HEALTH_PATH;
  const accept = web?.healthAcceptApp404 ?? false;
  if (spec.monitors) {
    return spec.monitors.map((m) => ({ type: m.type, hostname: m.hostname, path: m.path ?? healthPath, acceptApp404: m.accept_app_404 ?? accept }));
  }
  if (!web) return [];
  return web.hostnames.map((hostname) => ({ type: "http", hostname, path: healthPath, acceptApp404: accept }));
}

export function buildDesired(config: InfraConfig, observed: readonly ObservedDroplet[]): DesiredState {
  const { account } = config;
  const diagnostics: Diagnostic[] = [];
  const byName = new Map<string, ObservedDroplet[]>();
  for (const d of observed) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const fileNames = new Set(config.droplets.map((d) => d.file.name));

  const droplets: DesiredDroplet[] = config.droplets.map(({ file: spec, source }) => {
    const matches = byName.get(spec.name) ?? [];
    let status: DropletStatus;
    if (matches.length > 1) {
      status = "conflict";
      diagnostics.push({
        level: "error",
        code: "duplicate-droplet",
        file: source,
        droplet: spec.name,
        message: `${matches.length} droplets are named ${spec.name}; none of them is managed until only one is left`,
      });
    } else if (matches.length === 1) {
      status = "exists";
    } else if (spec.profile) {
      status = "create";
    } else {
      status = "missing";
      diagnostics.push({
        level: "error",
        code: "droplet-not-found",
        file: source,
        droplet: spec.name,
        message: `no droplet named ${spec.name} exists and the file has no profile to create one`,
      });
    }
    const obs = status === "exists" ? matches[0] : undefined;
    const f = flattenName(spec.name, account.cloudflare.zones);
    const region = obs ? obs.region : status === "create" && spec.env ? account.digitalocean.regions[spec.env] : undefined;
    const web = desiredWeb(spec);
    const sshWho = parseWhoList(spec.ssh);
    const profile = status === "create" && spec.profile ? config.profiles[spec.profile] : undefined;
    return {
      name: spec.name,
      source,
      spec,
      status,
      ...(obs ? { observed: obs } : {}),
      ...(profile ? { profile } : {}),
      ...(f.ok
        ? { zone: f.zone, label: f.label, sshHostname: f.sshHostname, vpcHostname: f.vpcHostname }
        : { namingError: f.reason }),
      ...(region ? { region } : {}),
      ...(region && account.cloudflare.tunnels[region] ? { tunnelId: account.cloudflare.tunnels[region] } : {}),
      ...(obs?.privateIpv4 ? { privateIpv4: obs.privateIpv4 } : {}),
      ...(obs?.publicIpv4 ? { publicIpv4: obs.publicIpv4 } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      frozen: spec.frozen,
      tags: desiredTags(spec),
      sshEmails: resolveSshAccess(account, spec.ssh),
      sshStaff: sshWho.some((w) => w.kind === "staff"),
      sshTokens: tokenNames(sshWho),
      ...(web ? { web } : {}),
      monitors: desiredMonitors(spec, web),
    };
  });

  const unmanaged = observed.filter((d) => !fileNames.has(d.name)).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  return { account, profiles: config.profiles, droplets, unmanaged, diagnostics };
}
