// Desired state: the droplet files joined with the droplets that exist now, with every
// default applied. This is the one input every module plans from, so they all agree on
// names, defaults and which droplets are new.
//
// Pure. The engine builds it after the droplets module has observed DigitalOcean, and
// builds it again during apply once new droplets are up (then they have IPs).

import {
  CI_DEPLOY_TAG,
  DEFAULT_HEALTH_PATH,
  DEFAULT_HEALTH_PATH_DEPLOY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_WEB_ORIGIN,
  ENV_TAGS,
  WEB_PUBLIC_TAG,
  WEB_STAFF_TAG,
} from "./constants.js";
import type { Diagnostic } from "./diagnostics.js";
import type { AccountConfig, DropletFile, EnvName, InfraConfig, Profile, WebException, WebExposure } from "./model.js";
import { flattenName } from "./naming.js";
import type { ObservedDroplet } from "./observed.js";

/**
 * - exists:   a droplet with this name exists; the file manages it (adopted or created earlier)
 * - create:   no droplet yet and the file has a profile; apply creates it
 * - missing:  no droplet and no profile; an error (nothing to manage, nothing to create)
 * - conflict: several droplets have this name; none of them is managed (as the Worker does)
 */
export type DropletStatus = "exists" | "create" | "missing" | "conflict";

export interface DesiredWeb {
  exposure: WebExposure;
  /** The Web tag this exposure writes. */
  tag: typeof WEB_STAFF_TAG | typeof WEB_PUBLIC_TAG;
  /** Origin with the default applied; {ip} still unresolved. */
  origin: string;
  /** Every site hostname: the droplet name first, then the extra hostnames in file order. */
  hostnames: string[];
  extraHostnames: string[];
  /** exposure public: the file's list or ["/admin"]. exposure staff: []. */
  protectedPaths: string[];
  exceptions: WebException[];
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
  deploy: boolean;
  frozen: boolean;
  /** The managed DigitalOcean tags this droplet should carry (subset of MANAGED_TAGS), sorted. */
  tags: string[];
  /**
   * The SSH access list resolved: groups expanded, emails lowercased, deduplicated, sorted. Who may
   * SSH into the droplet, always as ubuntu. An unknown group adds nothing (src/checks reports it).
   */
  sshEmails: string[];
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

export function desiredTags(spec: DropletFile): string[] {
  const tags: string[] = [];
  if (spec.env) tags.push(ENV_TAGS[spec.env]);
  if (spec.deploy) tags.push(CI_DEPLOY_TAG);
  if (spec.web) tags.push(spec.web.exposure === "staff" ? WEB_STAFF_TAG : WEB_PUBLIC_TAG);
  return tags.sort();
}

/** A droplet's ssh list with its groups expanded: lowercase emails, deduplicated, sorted. */
export function resolveSshAccess(account: AccountConfig, ssh: readonly string[]): string[] {
  const out = new Set<string>();
  for (const entry of ssh) {
    if (entry.includes("@")) out.add(entry.toLowerCase());
    else if (Object.hasOwn(account.ssh_groups, entry)) for (const e of account.ssh_groups[entry]!) out.add(e.toLowerCase());
  }
  return [...out].sort();
}

export function desiredWeb(spec: DropletFile): DesiredWeb | undefined {
  const w = spec.web;
  if (!w) return undefined;
  return {
    exposure: w.exposure,
    tag: w.exposure === "staff" ? WEB_STAFF_TAG : WEB_PUBLIC_TAG,
    origin: w.origin ?? DEFAULT_WEB_ORIGIN,
    hostnames: [spec.name, ...w.hostnames],
    extraHostnames: [...w.hostnames],
    protectedPaths: w.exposure === "public" ? [...(w.protected_paths ?? DEFAULT_PROTECTED_PATHS)] : [],
    exceptions: w.exceptions.map((e) => ({ ...e })),
    healthPath: w.health_path ?? (spec.deploy ? DEFAULT_HEALTH_PATH_DEPLOY : DEFAULT_HEALTH_PATH),
    healthAcceptApp404: w.health_accept_app_404,
  };
}

/** Explicit monitors with defaults from web, or one per site hostname when the file sets none. */
export function desiredMonitors(spec: DropletFile, web: DesiredWeb | undefined): DesiredMonitor[] {
  const healthPath = web?.healthPath ?? (spec.deploy ? DEFAULT_HEALTH_PATH_DEPLOY : DEFAULT_HEALTH_PATH);
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
      deploy: spec.deploy,
      frozen: spec.frozen,
      tags: desiredTags(spec),
      sshEmails: resolveSshAccess(account, spec.ssh),
      ...(web ? { web } : {}),
      monitors: desiredMonitors(spec, web),
    };
  });

  const unmanaged = observed.filter((d) => !fileNames.has(d.name)).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  return { account, profiles: config.profiles, droplets, unmanaged, diagnostics };
}
