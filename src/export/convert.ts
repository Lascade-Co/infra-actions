// The Worker's description of a droplet (its tags and its web-config.json entry) -> the droplet
// file's data in the current format (decisions 19 and 20). Pure. Used by the export, and by the
// tests that replay the Worker's own scenarios through droplet files, so both map a site the same way.
//
//   web-staff                      -> web.access "/": [staff]
//   web-public                     -> web.access "/": [everyone], plus each protected path
//                                     (default /admin) as [staff]
//   exception allow: everyone      -> "<path>": [everyone]
//   exception allow: {ips, tokens} -> "<path>": [ip:<cidr>..., token:<name>...]
//   ci-deploy (with env E)         -> token:<E's CI token> in ssh, plus "/healthcheck/": [everyone]
//                                     when the droplet has a site
//   env-*                          -> env
//
// Paths are kept as web-config.json spells them: the names of the existing Access apps embed them.

import { DEFAULT_PROTECTED_PATHS, HEALTH_BYPASS_PATH } from "../core/constants.js";
import type { EnvName } from "../core/model.js";
import { normPath } from "../core/values.js";

/** A web-config.json site entry, as the Worker reads it. */
export interface LegacySite {
  origin?: string;
  hostnames?: string[];
  protected_paths?: string[];
  exceptions?: unknown[];
  health_path?: string;
  health_accept_app_404?: boolean;
}

export interface LegacyDroplet {
  name: string;
  /** From the one env-* tag. */
  env?: EnvName;
  /** Tagged ci-deploy. */
  ciDeploy: boolean;
  /** web-staff / web-public; undefined: no web tag. */
  exposure?: "staff" | "public";
  /** Its web-config.json entry. */
  site?: LegacySite;
  frozen?: boolean;
  /** The people who may SSH in (group names and emails), e.g. ["admins"]. */
  people: string[];
}

export interface Converted {
  /** The droplet file's data (key order as written). */
  spec: Record<string, unknown>;
  /** What could not be carried over, for the export notes. */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `ciTokens`: the CI service-token names per environment (the Worker's CI_SERVICE_TOKEN_IDS, named). */
export function convertLegacy(d: LegacyDroplet, ciTokens: Partial<Record<EnvName, readonly string[]>>): Converted {
  const notes: string[] = [];
  const spec: Record<string, unknown> = { name: d.name };
  if (d.env) spec.env = d.env;
  if (d.frozen) spec.frozen = true;

  const tokens = d.ciDeploy && d.env ? [...(ciTokens[d.env] ?? [])] : [];
  if (d.ciDeploy && !d.env) notes.push("tagged ci-deploy without one environment tag: the Worker gives CI no SSH access, so no token is written");
  else if (d.ciDeploy && !tokens.length) notes.push(`tagged ci-deploy, but the Worker has no CI token for ${d.env}: no token is written`);
  spec.ssh = [...d.people, ...tokens.map((t) => `token:${t}`)];

  if (d.exposure) {
    const site = d.site ?? {};
    const access: Record<string, string[]> = {};
    const seen = new Set<string>();
    const add = (path: string, who: string[], what: string) => {
      const n = normPath(path);
      if (seen.has(n)) {
        notes.push(`${what} ${path} is already in web.access (as another rule for the same path); left out`);
        return;
      }
      seen.add(n);
      access[path] = who;
    };
    add("/", [d.exposure === "staff" ? "staff" : "everyone"], "root");
    if (d.exposure === "public") for (const p of site.protected_paths?.length ? site.protected_paths : DEFAULT_PROTECTED_PATHS) add(p, ["staff"], "protected path");
    else if (site.protected_paths?.length) notes.push("protected_paths on a web-staff site (the Worker ignores them too): not written");
    // The Worker's public /healthcheck of a deploy target wins over an exception or protected path there.
    const health = `/${HEALTH_BYPASS_PATH}`;
    if (d.ciDeploy) {
      for (const p of Object.keys(access)) {
        if (normPath(p) === health) {
          delete access[p];
          seen.delete(health);
          notes.push(`${p}: the Worker leaves it to the public healthcheck bypass of a deploy target; written as "/healthcheck/": [everyone]`);
        }
      }
    }
    for (const e of site.exceptions ?? []) {
      if (!isObj(e) || typeof e.path !== "string") {
        notes.push(`exception ${JSON.stringify(e)}: not an object with a path; left out`);
        continue;
      }
      if (d.ciDeploy && normPath(e.path) === health) {
        notes.push(`exception ${e.path}: the Worker leaves it to the public healthcheck bypass of a deploy target; left out`);
        continue;
      }
      const allow = e.allow;
      if (allow === "everyone") add(e.path, ["everyone"], "exception");
      else if (isObj(allow)) {
        const ips = Array.isArray(allow.ips) ? allow.ips.map((ip) => `ip:${String(ip)}`) : [];
        const toks = Array.isArray(allow.service_tokens) ? allow.service_tokens.map((t) => `token:${String(t)}`) : [];
        if (ips.length + toks.length) add(e.path, [...new Set([...ips, ...toks])], "exception");
        else notes.push(`exception ${e.path}: allow lists no one; left out`);
      } else notes.push(`exception ${e.path}: allow ${JSON.stringify(allow)} is not "everyone" or {ips, service_tokens}; left out`);
    }
    if (d.ciDeploy) add(`${health}/`, ["everyone"], "healthcheck");

    const web: Record<string, unknown> = {};
    if (site.origin !== undefined) web.origin = site.origin;
    if (site.hostnames?.length) web.hostnames = [...site.hostnames];
    web.access = access;
    if (site.health_path !== undefined) web.health_path = site.health_path;
    if (site.health_accept_app_404 !== undefined) web.health_accept_app_404 = site.health_accept_app_404;
    spec.web = web;
  }
  return { spec, notes };
}
