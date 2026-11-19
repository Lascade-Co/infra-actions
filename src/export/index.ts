// Export (phase D): the live state the infra-sync Worker manages today -> account.yaml and one
// droplet file per managed droplet, for the private infra repo.
//
// Inputs (all read-only, all real data, so never part of this repo):
//   - the DigitalOcean droplets (names, regions, tags, IPs);
//   - the Worker's [vars] from its wrangler.toml (account id, team domain, tunnels per region,
//     SSH_ADMIN_EMAILS, CI service-token ids, staff policy, Telegram chat, delete guards);
//   - the Worker's web-config.json (per-site origin, extra hostnames, exceptions, health);
//   - an account base (YAML in account.yaml's shape) for what the Worker doesn't hold: the
//     regions new droplets go to, the github and ssh_config sections, zones and token names
//     when the Cloudflare API isn't read, optional oneuptime;
//   - optional drafts of allow:/swarm: per droplet (report-only until migration Phase 5).
//
// Which droplets get a file: the Worker's own rule (its buildPlan): the name is a lowercase
// domain under an account zone and its region has a tunnel. Droplets with no tags at all are
// left out unless asked (they need an owner's decision first) and listed in the notes.
//
// What each file holds, so the tool's plan matches what the Worker does today:
//   - env from the one env-* tag; deploy from ci-deploy; web.exposure from web-staff or
//     web-public, plus the site's web-config.json entry (only the keys it sets: defaults stay
//     defaults);
//   - ssh: [admins], the group of today's SSH_ADMIN_EMAILS (same people, ubuntu only);
//   - frozen: true for the droplets named as frozen;
//   - the drafts, under a DRAFT comment, minus any entry the schema or the checks reject.
// Anything that can't be expressed without changing a tag (a web-config.json entry on a
// droplet with no web tag, both web tags, ci-deploy without env) is left out and noted.
//
// Pure: buildExport takes parsed inputs and returns file texts plus notes. src/export/run.ts
// does the reading and writing.

import { stringify } from "yaml";
import { checkConfig, checkDesired } from "../checks/index.js";
import { CI_DEPLOY_TAG, ENV_TAGS, WEB_PUBLIC_TAG, WEB_STAFF_TAG } from "../core/constants.js";
import { buildDesired } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import { ACCOUNT_FILE, loadInfraFiles, type InfraFiles } from "../core/loader.js";
import { ENV_NAMES, type EnvName } from "../core/model.js";
import { flattenName } from "../core/naming.js";
import type { ObservedDroplet } from "../core/observed.js";

export const SCHEMA_URL_BASE = "https://raw.githubusercontent.com/Lascade-Co/infra-actions/main/schema";
export const ADMINS_GROUP = "admins";

export interface ExportInput {
  droplets: readonly ObservedDroplet[];
  /** The Worker's [vars] (wrangler.toml). */
  vars: Record<string, string>;
  /** The Worker's web-config.json, parsed. */
  webConfig: unknown;
  /** account.yaml-shaped base values (parsed YAML). */
  base: Record<string, unknown>;
  /** Zones from the Cloudflare API; when absent, base cloudflare.zones. */
  zones?: string[];
  /** { droplets: { <name>: { allow?, swarm? } } } (parsed YAML). */
  drafts?: unknown;
  frozen?: readonly string[];
  includeUntagged?: boolean;
  /** For the header comment, e.g. 2026-11-19. */
  date: string;
}

export interface ExportNote {
  name: string;
  reason: string;
}

export interface ExportNotes {
  written: string[];
  /** Managed by the Worker's rule but not written. */
  leftOut: ExportNote[];
  /** Not managed by the Worker (no zone, or a region without a tunnel). */
  notManaged: ExportNote[];
  /** web-config.json entries not written into a file. */
  webNotWritten: ExportNote[];
  /** Draft entries dropped because the schema or the checks reject them. */
  draftsDropped: ExportNote[];
  /** Everything else worth reading before the files are used. */
  warnings: string[];
}

export interface ExportResult {
  /** Relative path -> text (account.yaml, droplets/<name>.yaml). */
  files: InfraFiles;
  notes: ExportNotes;
}

export class ExportError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function jsonVar<T>(vars: Record<string, string>, name: string): T {
  const raw = vars[name];
  if (raw === undefined || raw.trim() === "") throw new ExportError(`the Worker vars have no ${name}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ExportError(`the Worker var ${name} is not valid JSON`);
  }
}

function strVar(vars: Record<string, string>, name: string): string {
  const v = vars[name]?.trim();
  if (!v) throw new ExportError(`the Worker vars have no ${name}`);
  return v;
}

/** The Worker's parseEmails: comma-separated, trimmed, lowercased, deduplicated, sorted. */
export function adminEmails(vars: Record<string, string>): string[] {
  const list = (vars.SSH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) throw new ExportError("the Worker vars have no SSH_ADMIN_EMAILS");
  return [...new Set(list)].sort();
}

// ---------- account.yaml ----------

interface AccountBuild {
  account: Record<string, unknown>;
  zones: string[];
  tunnels: Record<string, string>;
}

function buildAccount(input: ExportInput, warnings: string[]): AccountBuild {
  const { vars, base } = input;
  const baseCf = isObj(base.cloudflare) ? base.cloudflare : {};
  const zones = [...new Set((input.zones ?? (Array.isArray(baseCf.zones) ? (baseCf.zones as string[]) : [])).map((z) => z.toLowerCase()))].sort();
  if (!zones.length) throw new ExportError("no zones: read them from the Cloudflare API (CF_API_TOKEN) or give cloudflare.zones in the account base");
  const tunnels = jsonVar<Record<string, string>>(vars, "TUNNELS_BY_REGION");

  // Service tokens: every CI token id gets a name. A name from the base (same id) wins; otherwise
  // ci-<first env that uses it>.
  const ciIds = jsonVar<Partial<Record<EnvName, string[]>>>(vars, "CI_SERVICE_TOKEN_IDS");
  const baseTokens = isObj(baseCf.service_tokens) ? (baseCf.service_tokens as Record<string, string>) : {};
  const tokens: Record<string, string> = { ...baseTokens };
  const nameOf = new Map(Object.entries(baseTokens).map(([n, id]) => [id.toLowerCase(), n]));
  const ciDeploy: Record<EnvName, string[]> = { prod: [], staging: [], internal: [] };
  for (const env of ENV_NAMES) {
    for (const raw of ciIds[env] ?? []) {
      const id = raw.toLowerCase();
      let name = nameOf.get(id);
      if (!name) {
        name = `ci-${env}`;
        for (let i = 2; name in tokens; i++) name = `ci-${env}-${i}`;
        tokens[name] = id;
        nameOf.set(id, name);
      }
      if (!ciDeploy[env].includes(name)) ciDeploy[env].push(name);
    }
  }

  const guards: Record<string, number> = {};
  if (vars.MAX_DELETES?.trim()) guards.max_deletes = Number(vars.MAX_DELETES);
  if (vars.MAX_DELETE_FRACTION?.trim()) guards.max_delete_fraction = Number(vars.MAX_DELETE_FRACTION);

  const admins = adminEmails(vars);
  const domains = [...new Set(admins.map((e) => e.split("@")[1]!))];
  const emailDomain = typeof base.ssh_email_domain === "string" ? base.ssh_email_domain : domains[0]!;
  if (domains.some((d) => d !== emailDomain)) warnings.push(`SSH_ADMIN_EMAILS has addresses outside ${emailDomain}; the checks will reject them`);
  const baseGroups = isObj(base.ssh_groups) ? (base.ssh_groups as Record<string, string[]>) : {};

  const account: Record<string, unknown> = {
    cloudflare: {
      account_id: strVar(vars, "CF_ACCOUNT_ID").toLowerCase(),
      team_domain: strVar(vars, "TEAM_DOMAIN"),
      zones,
      tunnels,
      staff_policy_id: strVar(vars, "STAFF_POLICY_ID").toLowerCase(),
      service_tokens: Object.fromEntries(Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b))),
      ci_deploy_tokens: ciDeploy,
      ...(Object.keys(guards).length ? { guards } : {}),
    },
    ...(isObj(base.digitalocean) ? { digitalocean: base.digitalocean } : {}),
    ...(isObj(base.oneuptime) ? { oneuptime: base.oneuptime } : {}),
    ...(isObj(base.github) ? { github: base.github } : {}),
    ...(vars.TELEGRAM_CHAT_ID?.trim() ? { telegram: { chat_id: vars.TELEGRAM_CHAT_ID.trim() } } : isObj(base.telegram) ? { telegram: base.telegram } : {}),
    ...(isObj(base.ssh_config) ? { ssh_config: base.ssh_config } : {}),
    ssh_email_domain: emailDomain,
    ssh_groups: { ...baseGroups, [ADMINS_GROUP]: admins },
  };
  for (const k of ["digitalocean", "github", "ssh_config"]) {
    if (!(k in account)) throw new ExportError(`the account base has no ${k} section (the Worker doesn't hold it)`);
  }
  return { account, zones, tunnels };
}

// ---------- droplet files ----------

interface WebSite {
  origin?: string;
  hostnames?: string[];
  protected_paths?: string[];
  exceptions?: unknown[];
  health_path?: string;
  health_accept_app_404?: boolean;
}

interface Drafts {
  allow?: Record<string, unknown[]>;
  swarm?: Record<string, unknown>;
}

function draftsOf(raw: unknown): Map<string, Drafts> {
  const out = new Map<string, Drafts>();
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw) || !isObj(raw.droplets)) throw new ExportError("the drafts file must be { droplets: { <name>: { allow?, swarm? } } }");
  for (const [name, v] of Object.entries(raw.droplets)) {
    if (!isObj(v)) throw new ExportError(`drafts: ${name} must be an object`);
    const d: Drafts = {};
    if (isObj(v.allow)) {
      d.allow = {};
      for (const [kind, list] of Object.entries(v.allow)) if (Array.isArray(list) && list.length) d.allow[kind] = [...list];
    }
    if (isObj(v.swarm)) d.swarm = { ...v.swarm };
    out.set(name, d);
  }
  return out;
}

interface Planned {
  name: string;
  spec: Record<string, unknown>;
  drafts: Drafts;
}

function renderDroplet(p: Planned, date: string): string {
  const head = [
    `# yaml-language-server: $schema=${SCHEMA_URL_BASE}/droplet.schema.json`,
    `# Exported from the live state on ${date} (phase D): tags, the Worker's web-config.json and SSH_ADMIN_EMAILS.`,
  ];
  if (p.spec.frozen) head.push("# frozen: plans show its changes, apply skips them, except its SSH access (decision 18, option b).");
  let text = `${head.join("\n")}\n${stringify(p.spec, { lineWidth: 0 })}`;
  const draft: Record<string, unknown> = {};
  const allow = Object.fromEntries(Object.entries(p.drafts.allow ?? {}).filter(([, l]) => l.length));
  if (Object.keys(allow).length) draft.allow = allow;
  if (p.drafts.swarm) draft.swarm = p.drafts.swarm;
  if (Object.keys(draft).length) {
    text +=
      "\n# DRAFT from server-to-server-map.md (2026-11-17 snapshots, not a 24-hour sample). Firewall rules are\n" +
      "# report-only until migration Phase 5: review these entries before then.\n" +
      stringify(draft, { lineWidth: 0 });
  }
  return text;
}

function renderAccount(account: Record<string, unknown>, date: string): string {
  return (
    `# yaml-language-server: $schema=${SCHEMA_URL_BASE}/account.schema.json\n` +
    `# Exported on ${date} (phase D) from the Worker's settings (wrangler.toml [vars]) and the account base.\n` +
    "# No secrets: tokens come from environment variables.\n" +
    stringify(account, { lineWidth: 0 })
  );
}

/** Drops the draft entry or swarm block a diagnostic points at. Returns a note, or undefined. */
function dropDraft(p: Planned, d: Diagnostic): string | undefined {
  const path = d.path ?? "";
  const m = /^allow\.(droplet|tunnel|ip)\[(\d+)\]/.exec(path);
  if (m) {
    const list = p.drafts.allow?.[m[1]!];
    const i = Number(m[2]);
    if (!list || i >= list.length || list[i] === null) return undefined;
    const entry = JSON.stringify(list[i]);
    list[i] = null as unknown as never; // keep indexes stable until this round is done
    return `allow.${m[1]} ${entry}: ${d.code}: ${d.message}`;
  }
  if ((path.startsWith("swarm") || d.code.startsWith("swarm-")) && p.drafts.swarm) {
    const s = JSON.stringify(p.drafts.swarm);
    delete p.drafts.swarm;
    return `swarm ${s}: ${d.code}: ${d.message}`;
  }
  return undefined;
}

export function buildExport(input: ExportInput): ExportResult {
  const notes: ExportNotes = { written: [], leftOut: [], notManaged: [], webNotWritten: [], draftsDropped: [], warnings: [] };
  const { account, zones, tunnels } = buildAccount(input, notes.warnings);

  const sites = isObj(input.webConfig) && isObj(input.webConfig.sites) ? (input.webConfig.sites as Record<string, WebSite>) : {};
  if (!isObj(input.webConfig) || !isObj(input.webConfig.sites)) notes.warnings.push("web-config.json has no sites object");
  const drafts = draftsOf(input.drafts);
  const frozen = new Set(input.frozen ?? []);

  const byName = new Map<string, ObservedDroplet[]>();
  for (const d of input.droplets) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);

  const planned: Planned[] = [];
  for (const name of [...byName.keys()].sort()) {
    const all = byName.get(name)!;
    const d = all[0]!;
    const f = flattenName(name, zones);
    if (!f.ok) {
      notes.notManaged.push({ name, reason: f.reason });
      continue;
    }
    if (!tunnels[d.region]) {
      notes.notManaged.push({ name, reason: `region ${d.region} has no tunnel` });
      continue;
    }
    if (all.length > 1) notes.warnings.push(`${name}: ${all.length} droplets have this name; the tool manages none of them until one is left`);
    if (d.tags.length === 0 && !input.includeUntagged) {
      notes.leftOut.push({ name, reason: "no tags at all: left out until its owner decides (the Worker still manages it by name)" });
      continue;
    }
    const spec: Record<string, unknown> = { name };
    const envs = ENV_NAMES.filter((e) => d.tags.includes(ENV_TAGS[e]));
    if (envs.length === 1) spec.env = envs[0];
    else if (envs.length > 1) notes.warnings.push(`${name}: several environment tags (${envs.join(", ")}); env left out, so the apply would remove them`);
    if (d.tags.includes(CI_DEPLOY_TAG)) {
      if (spec.env) spec.deploy = true;
      else notes.warnings.push(`${name}: tagged ${CI_DEPLOY_TAG} without one environment tag; deploy left out (the schema needs env), so the apply would remove ${CI_DEPLOY_TAG}`);
    }
    if (frozen.has(name)) spec.frozen = true;
    spec.ssh = [ADMINS_GROUP];

    const staff = d.tags.includes(WEB_STAFF_TAG);
    const pub = d.tags.includes(WEB_PUBLIC_TAG);
    const site = sites[name];
    if (staff && pub) {
      notes.warnings.push(`${name}: tagged both ${WEB_STAFF_TAG} and ${WEB_PUBLIC_TAG}; web left out, so the apply would remove both tags`);
      if (site) notes.webNotWritten.push({ name, reason: "both web tags" });
    } else if (staff || pub) {
      const web: Record<string, unknown> = { exposure: staff ? "staff" : "public" };
      if (site) {
        if (site.origin !== undefined) web.origin = site.origin;
        if (site.hostnames?.length) web.hostnames = [...site.hostnames];
        if (site.protected_paths?.length) {
          if (pub) web.protected_paths = [...site.protected_paths];
          else notes.webNotWritten.push({ name, reason: "protected_paths on a web-staff site (the Worker ignores them too)" });
        }
        if (site.exceptions?.length) web.exceptions = site.exceptions.map((e) => (isObj(e) ? { ...e } : e));
        if (site.health_path !== undefined) web.health_path = site.health_path;
        if (site.health_accept_app_404 !== undefined) web.health_accept_app_404 = site.health_accept_app_404;
      }
      spec.web = web;
    } else if (site) {
      notes.webNotWritten.push({ name, reason: `web-config.json has an entry but the droplet has no web tag; the Worker builds no site for it, and a web: block would add a ${WEB_STAFF_TAG}/${WEB_PUBLIC_TAG} tag` });
    }
    const dr = drafts.get(name) ?? {};
    drafts.delete(name);
    planned.push({ name, spec, drafts: { ...(dr.allow ? { allow: { ...dr.allow } } : {}), ...(dr.swarm ? { swarm: dr.swarm } : {}) } });
  }
  for (const name of Object.keys(sites)) {
    if (!byName.has(name)) notes.webNotWritten.push({ name, reason: "web-config.json entry matches no droplet" });
  }
  for (const name of drafts.keys()) notes.draftsDropped.push({ name, reason: "drafts for a droplet that gets no file" });

  // Render, then drop draft entries the schema or the checks reject, until none is left.
  const render = (): InfraFiles => {
    const files: InfraFiles = { [ACCOUNT_FILE]: renderAccount(account, input.date) };
    for (const p of planned) files[`droplets/${p.name}.yaml`] = renderDroplet(p, input.date);
    return files;
  };
  const byFile = new Map(planned.map((p) => [`droplets/${p.name}.yaml`, p]));
  for (let round = 0; round < 20; round++) {
    const res = loadInfraFiles(render());
    let diags = res.diagnostics;
    if (res.config) {
      diags = [...diags, ...checkConfig(res.config)];
      const desired = buildDesired(res.config, input.droplets);
      diags = [...diags, ...desired.diagnostics, ...checkDesired(desired)];
    }
    let dropped = 0;
    for (const d of diags) {
      if (d.level !== "error" || !d.file) continue;
      const p = byFile.get(d.file);
      if (!p) continue;
      const note = dropDraft(p, d);
      if (note) {
        notes.draftsDropped.push({ name: p.name, reason: note });
        dropped++;
      }
    }
    for (const p of planned) {
      for (const k of Object.keys(p.drafts.allow ?? {})) p.drafts.allow![k] = p.drafts.allow![k]!.filter((x) => x !== null);
    }
    if (!dropped) break;
  }

  notes.written = planned.map((p) => p.name);
  return { files: render(), notes };
}

/** The notes as markdown (real names: write it only to a path outside this repo). */
export function renderNotes(n: ExportNotes): string {
  const list = (title: string, items: ExportNote[]) =>
    items.length ? [`## ${title} (${items.length})`, "", ...items.map((x) => `- \`${x.name}\`: ${x.reason}`), ""] : [];
  return [
    "# infra export: notes",
    "",
    `Droplet files written: ${n.written.length}.`,
    "",
    ...list("Managed by the Worker's rule, left out", n.leftOut),
    ...list("Not managed by the Worker", n.notManaged),
    ...list("web-config.json entries not written", n.webNotWritten),
    ...list("Draft entries dropped", n.draftsDropped),
    ...(n.warnings.length ? [`## Warnings (${n.warnings.length})`, "", ...n.warnings.map((w) => `- ${w}`), ""] : []),
  ].join("\n");
}
