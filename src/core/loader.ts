// Loader: an `infra` checkout -> typed InfraConfig, or precise diagnostics (file, dotted
// path, line).
//
// What the loader checks (single-file rules):
//   - the layout: account.yaml, droplets/<name>.yaml, profiles/<name>.yaml,
//     profiles/user-data/<file>; anything else in droplets/ or profiles/ is an error
//     (so a droplet can never silently look like it has no file); no symlinks;
//   - YAML: one document per file, no duplicate keys;
//   - the JSON Schema of each file kind;
//   - rules inside one file the schema can't express: file name == name, ports, CIDRs,
//     duplicate or clashing paths, reserved ssh-/vpc- prefixes, monitor hostnames, a
//     profile's user_data file, account-internal references.
//
// What it does NOT check (cross-file and account-dependent rules belong to src/checks):
// profile names exist, references to other droplets, service-token names, zones and
// one-level names, a hostname claimed by two files, swarm rules, UDP only for staff.

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, parseAllDocuments, type Document } from "yaml";
import { RESERVED_PREFIXES, DEFAULT_PROTECTED_PATHS } from "./constants.js";
import type { Diagnostic } from "./diagnostics.js";
import { hasErrors } from "./diagnostics.js";
import type {
  AccountConfig,
  AllowSpec,
  DropletEntry,
  DropletFile,
  EnvName,
  ExceptionAllow,
  InfraConfig,
  MonitorSpec,
  Profile,
  ProfileFile,
  WebException,
  WebSpec,
} from "./model.js";
import { ENV_NAMES } from "./model.js";
import { dottedPath, validate, type SchemaKind } from "./schema.js";
import { normPath, parseCidr, parsePort, parseWho, ValueError } from "./values.js";

export interface LoadResult {
  /** Present only when there are no error diagnostics. */
  config?: InfraConfig;
  diagnostics: Diagnostic[];
}

/** Relative path (forward slashes) -> file contents. */
export type InfraFiles = Record<string, string>;

export const ACCOUNT_FILE = "account.yaml";
export const DROPLETS_DIR = "droplets";
export const PROFILES_DIR = "profiles";
export const USER_DATA_DIR = "profiles/user-data";
/** Files that may sit in droplets/ and profiles/ without being data. */
const IGNORED_NAMES = new Set(["README.md", ".gitkeep"]);
const MAX_FILE_BYTES = 256 * 1024;

const DROPLET_FILE_RE = /^droplets\/([a-z0-9.-]+)\.yaml$/;
const PROFILE_FILE_RE = /^profiles\/([a-z0-9][a-z0-9-]*)\.yaml$/;
const USER_DATA_FILE_RE = /^profiles\/user-data\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

// ---------- reading a directory ----------

/**
 * Reads account.yaml and everything under droplets/ and profiles/ (recursively, so that
 * stray subdirectories are reported). Symlinks and oversized files are reported, never
 * followed or read: a pull request must not be able to make the tool read other files.
 */
export async function readInfraDir(dir: string): Promise<{ files: InfraFiles; diagnostics: Diagnostic[] }> {
  const files: InfraFiles = {};
  const diagnostics: Diagnostic[] = [];
  const readOne = async (rel: string) => {
    const abs = join(dir, rel);
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      diagnostics.push({ level: "error", code: "layout", file: rel, message: "symlinks are not allowed in the infra repo" });
    } else if (st.isDirectory()) {
      for (const name of (await readdir(abs)).sort()) await readOne(`${rel}/${name}`);
    } else if (!st.isFile()) {
      diagnostics.push({ level: "error", code: "layout", file: rel, message: "not a regular file" });
    } else if (st.size > MAX_FILE_BYTES) {
      diagnostics.push({ level: "error", code: "layout", file: rel, message: `file is larger than ${MAX_FILE_BYTES} bytes` });
    } else {
      files[rel] = await readFile(abs, "utf8");
    }
  };
  for (const top of [ACCOUNT_FILE, DROPLETS_DIR, PROFILES_DIR]) {
    try {
      await lstat(join(dir, top));
    } catch {
      if (top !== PROFILES_DIR) diagnostics.push({ level: "error", code: "layout", file: top, message: "missing" });
      continue;
    }
    await readOne(top);
  }
  return { files, diagnostics };
}

export async function loadInfraDir(dir: string): Promise<LoadResult> {
  const { files, diagnostics } = await readInfraDir(dir);
  const res = loadInfraFiles(files);
  const all = [...diagnostics, ...res.diagnostics];
  return hasErrors(all) ? { diagnostics: all } : { config: res.config!, diagnostics: all };
}

// ---------- parsing ----------

interface Parsed {
  data: unknown;
  doc: Document;
  lines: LineCounter;
}

class FileCtx {
  constructor(
    readonly file: string,
    readonly out: Diagnostic[],
    private readonly parsed?: Parsed,
    readonly droplet?: string,
  ) {}

  lineOf(segments: ReadonlyArray<string | number>): number | undefined {
    if (!this.parsed) return undefined;
    // The deepest node that exists along the path.
    for (let n = segments.length; n >= 0; n--) {
      const node = this.parsed.doc.getIn(segments.slice(0, n), true) as { range?: [number, number, number] } | undefined;
      if (node && node.range) return this.parsed.lines.linePos(node.range[0]).line;
    }
    return undefined;
  }

  err(segments: ReadonlyArray<string | number>, message: string, code = "invalid") {
    const path = dottedPath(segments);
    this.out.push({
      level: "error",
      code,
      file: this.file,
      ...(path ? { path } : {}),
      ...(this.lineOf(segments) !== undefined ? { line: this.lineOf(segments) } : {}),
      ...(this.droplet ? { droplet: this.droplet } : {}),
      message,
    });
  }

  warn(segments: ReadonlyArray<string | number>, message: string, code = "warning") {
    const path = dottedPath(segments);
    this.out.push({ level: "warning", code, file: this.file, ...(path ? { path } : {}), message });
  }
}

function parseYaml(file: string, text: string, out: Diagnostic[]): Parsed | undefined {
  const lines = new LineCounter();
  const docs = parseAllDocuments(text, { uniqueKeys: true, lineCounter: lines, prettyErrors: false });
  if (!Array.isArray(docs)) {
    out.push({ level: "error", code: "yaml", file, message: "file is empty" });
    return undefined;
  }
  if (docs.length !== 1) {
    out.push({ level: "error", code: "yaml", file, message: `file has ${docs.length} YAML documents; exactly one is allowed` });
    return undefined;
  }
  const doc = docs[0]!;
  if (doc.errors.length) {
    for (const e of doc.errors) {
      out.push({ level: "error", code: "yaml", file, line: lines.linePos(e.pos[0]).line, message: e.message.split("\n")[0]! });
    }
    return undefined;
  }
  const data = doc.toJS({ maxAliasCount: 50 }) as unknown;
  return { data, doc, lines };
}

function schemaCheck(kind: SchemaKind, ctx: FileCtx, data: unknown): boolean {
  const issues = validate(kind, data);
  for (const i of issues) ctx.err(i.segments, i.message, "schema");
  return issues.length === 0;
}

/** Validates and converts every file. Pure: no file system access. */
export function loadInfraFiles(files: InfraFiles): LoadResult {
  const diagnostics: Diagnostic[] = [];
  const userData = new Map<string, string>();
  const profileFiles: Array<[string, string]> = [];
  const dropletFiles: Array<[string, string]> = [];

  for (const rel of Object.keys(files).sort()) {
    const base = rel.split("/").pop()!;
    if (rel === ACCOUNT_FILE) continue;
    if (IGNORED_NAMES.has(base) && (rel.startsWith(`${DROPLETS_DIR}/`) || rel.startsWith(`${PROFILES_DIR}/`))) continue;
    if (USER_DATA_FILE_RE.test(rel)) userData.set(USER_DATA_FILE_RE.exec(rel)![1]!, files[rel]!);
    else if (PROFILE_FILE_RE.test(rel)) profileFiles.push([rel, files[rel]!]);
    else if (DROPLET_FILE_RE.test(rel)) dropletFiles.push([rel, files[rel]!]);
    else if (rel.startsWith(`${DROPLETS_DIR}/`)) {
      diagnostics.push({
        level: "error",
        code: "layout",
        file: rel,
        message: "droplets/ may only hold <droplet name>.yaml files (lowercase, .yaml, no subdirectories)",
      });
    } else if (rel.startsWith(`${PROFILES_DIR}/`)) {
      diagnostics.push({
        level: "error",
        code: "layout",
        file: rel,
        message: "profiles/ may only hold <profile>.yaml files and cloud-init files in profiles/user-data/",
      });
    }
    // Anything else in the checkout (README, workflows...) is not the tool's business.
  }

  // account.yaml
  let account: AccountConfig | undefined;
  if (files[ACCOUNT_FILE] === undefined) {
    diagnostics.push({ level: "error", code: "layout", file: ACCOUNT_FILE, message: "missing" });
  } else {
    const parsed = parseYaml(ACCOUNT_FILE, files[ACCOUNT_FILE]!, diagnostics);
    if (parsed) {
      const ctx = new FileCtx(ACCOUNT_FILE, diagnostics, parsed);
      if (schemaCheck("account", ctx, parsed.data)) account = toAccount(parsed.data as RawAccount, ctx);
    }
  }

  // profiles
  const profiles: Record<string, Profile> = {};
  const usedUserData = new Set<string>();
  for (const [rel, text] of profileFiles) {
    const parsed = parseYaml(rel, text, diagnostics);
    if (!parsed) continue;
    const ctx = new FileCtx(rel, diagnostics, parsed);
    if (!schemaCheck("profile", ctx, parsed.data)) continue;
    const p = parsed.data as ProfileFile;
    const fileName = PROFILE_FILE_RE.exec(rel)![1]!;
    let ok = true;
    if (p.name !== fileName) {
      ctx.err(["name"], `name "${p.name}" must equal the file name "${fileName}"`, "file-name");
      ok = false;
    }
    const ud = userData.get(p.user_data);
    usedUserData.add(p.user_data);
    if (ud === undefined) {
      ctx.err(["user_data"], `${USER_DATA_DIR}/${p.user_data} does not exist`, "user-data");
      ok = false;
    } else if (!ud.startsWith("#cloud-config")) {
      ctx.err(["user_data"], `${USER_DATA_DIR}/${p.user_data} must start with #cloud-config`, "user-data");
      ok = false;
    }
    if (ok && ud !== undefined) profiles[p.name] = { ...p, userDataText: ud, source: rel };
  }
  for (const name of userData.keys()) {
    if (!usedUserData.has(name)) {
      diagnostics.push({ level: "warning", code: "unused-user-data", file: `${USER_DATA_DIR}/${name}`, message: "no profile uses this file" });
    }
  }

  // droplets
  const droplets: DropletEntry[] = [];
  for (const [rel, text] of dropletFiles) {
    const fileName = DROPLET_FILE_RE.exec(rel)![1]!;
    const parsed = parseYaml(rel, text, diagnostics);
    if (!parsed) continue;
    const ctx = new FileCtx(rel, diagnostics, parsed, fileName);
    // Checked before the schema, so a renamed file is reported even when it has other problems.
    const rawName = (parsed.data as { name?: unknown } | null)?.name;
    const nameOk = typeof rawName !== "string" || rawName === fileName;
    if (!nameOk) ctx.err(["name"], `name "${String(rawName)}" must equal the file name "${fileName}"`, "file-name");
    if (!schemaCheck("droplet", ctx, parsed.data) || !nameOk) continue;
    const before = diagnostics.length;
    const file = toDroplet(parsed.data as RawDroplet, ctx);
    if (diagnostics.slice(before).some((d) => d.level === "error")) continue;
    droplets.push({ file, source: rel });
  }
  droplets.sort((a, b) => a.file.name.localeCompare(b.file.name));

  if (hasErrors(diagnostics) || !account) return { diagnostics };
  return { config: { account, profiles, droplets }, diagnostics };
}

// ---------- account ----------

type RawAccount = Omit<AccountConfig, "cloudflare" | "github" | "ssh_config" | "ssh_groups"> & {
  ssh_groups?: Record<string, string[]>;
  cloudflare: Omit<AccountConfig["cloudflare"], "guards"> & { guards?: Partial<AccountConfig["cloudflare"]["guards"]> };
  github: { infra_repo: string; ssh_config_branch?: string; ssh_config_file?: string };
  ssh_config: { title: string; user?: string };
};

function toAccount(raw: RawAccount, ctx: FileCtx): AccountConfig {
  const cf = raw.cloudflare;
  for (const env of ENV_NAMES) {
    cf.ci_deploy_tokens[env].forEach((name, i) => {
      if (!(name in cf.service_tokens)) {
        ctx.err(["cloudflare", "ci_deploy_tokens", env, i], `service token "${name}" is not in cloudflare.service_tokens`, "unknown-service-token");
      }
    });
    const region = raw.digitalocean.regions[env];
    if (!(region in cf.tunnels)) {
      ctx.err(["digitalocean", "regions", env], `region "${region}" has no tunnel in cloudflare.tunnels`, "region-without-tunnel");
    }
  }
  const ids = Object.values(cf.service_tokens);
  if (new Set(ids).size !== ids.length) ctx.err(["cloudflare", "service_tokens"], "two names point at the same service token id", "invalid");
  return {
    ...raw,
    cloudflare: {
      ...cf,
      zones: [...cf.zones].sort(),
      guards: { max_deletes: cf.guards?.max_deletes ?? 20, max_delete_fraction: cf.guards?.max_delete_fraction ?? 0.3 },
    },
    github: {
      infra_repo: raw.github.infra_repo,
      ssh_config_branch: raw.github.ssh_config_branch ?? "ssh-config",
      ssh_config_file: raw.github.ssh_config_file ?? "ssh_config",
    },
    ssh_config: { title: raw.ssh_config.title, user: raw.ssh_config.user ?? "ubuntu" },
    ssh_email_domain: raw.ssh_email_domain.toLowerCase(),
    // The domain of each email is checked in src/checks (with the droplet files' emails).
    ssh_groups: Object.fromEntries(
      Object.entries(raw.ssh_groups ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, emails]) => [name, [...new Set(emails.map((e) => e.toLowerCase()))].sort()]),
    ),
  };
}

// ---------- droplet ----------

interface RawDroplet {
  name: string;
  description?: string;
  profile?: string;
  env?: EnvName;
  deploy?: boolean;
  frozen?: boolean;
  ssh: string[];
  web?: {
    exposure: WebSpec["exposure"];
    origin?: string;
    hostnames?: string[];
    protected_paths?: string[];
    exceptions?: Array<{ path: string; allow: "everyone" | { ips?: string[]; service_tokens?: string[] } }>;
    health_path?: string;
    health_accept_app_404?: boolean;
  };
  monitors?: Array<{ type?: "http"; hostname: string; path?: string; accept_app_404?: boolean }>;
  allow?: {
    droplet?: Array<{ from: string; ports: string[]; note?: string }>;
    tunnel?: Array<{ route: string; port: string; who: string[]; note?: string }>;
    ip?: Array<{ from: string; ports: string[]; note?: string }>;
  };
  swarm?: { cluster: string; role?: "manager" | "worker"; encrypted_overlay?: boolean };
}

const isReserved = (h: string) => RESERVED_PREFIXES.some((p) => h.startsWith(p));

function value<T>(ctx: FileCtx, segments: Array<string | number>, f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof ValueError) {
      ctx.err(segments, e.message);
      return undefined;
    }
    throw e;
  }
}

function toWeb(raw: NonNullable<RawDroplet["web"]>, name: string, ctx: FileCtx): WebSpec {
  const hostnames = raw.hostnames ?? [];
  hostnames.forEach((h, i) => {
    if (isReserved(h)) ctx.err(["web", "hostnames", i], `${h}: names starting with ${RESERVED_PREFIXES.join(" or ")} are generated by the tool`);
    if (h === name) ctx.err(["web", "hostnames", i], `${h} is the droplet's own name; list only extra hostnames`);
  });

  const protectedPaths = raw.protected_paths;
  if (protectedPaths) {
    const seen = new Set<string>();
    protectedPaths.forEach((p, i) => {
      const n = normPath(p);
      if (n === "") ctx.err(["web", "protected_paths", i], `"${p}" protects the whole site; use exposure: staff instead`);
      if (p.includes("//")) ctx.err(["web", "protected_paths", i], `"${p}" has an empty segment (//)`);
      if (seen.has(n)) ctx.err(["web", "protected_paths", i], `duplicate path ${p}`);
      seen.add(n);
    });
  }

  const effectiveProtected = new Set(
    raw.exposure === "public" ? (protectedPaths ?? DEFAULT_PROTECTED_PATHS).map(normPath) : [],
  );
  const exceptions: WebException[] = [];
  const seenExc = new Set<string>();
  (raw.exceptions ?? []).forEach((e, i) => {
    const n = normPath(e.path);
    if (n === "") ctx.err(["web", "exceptions", i, "path"], `"${e.path}" is the whole site; not an exception`);
    if (e.path.includes("//")) ctx.err(["web", "exceptions", i, "path"], `"${e.path}" has an empty segment (//)`);
    if (seenExc.has(n)) ctx.err(["web", "exceptions", i, "path"], `duplicate exception path ${e.path}`);
    seenExc.add(n);
    if (effectiveProtected.has(n)) ctx.err(["web", "exceptions", i, "path"], `${e.path} is both a protected path and an exception`);
    let allow: ExceptionAllow;
    if (e.allow === "everyone") allow = "everyone";
    else {
      const a: { ips?: string[]; service_tokens?: string[] } = {};
      if (e.allow.ips) {
        const ips = e.allow.ips.map((ip, j) => value(ctx, ["web", "exceptions", i, "allow", "ips", j], () => parseCidr(ip)));
        a.ips = [...new Set(ips.filter((x): x is string => x !== undefined))].sort();
      }
      if (e.allow.service_tokens) a.service_tokens = [...e.allow.service_tokens].sort();
      allow = a;
    }
    exceptions.push({ path: e.path, allow });
  });

  return {
    exposure: raw.exposure,
    ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
    hostnames: [...hostnames],
    ...(protectedPaths ? { protected_paths: [...protectedPaths] } : {}),
    exceptions,
    ...(raw.health_path !== undefined ? { health_path: raw.health_path } : {}),
    health_accept_app_404: raw.health_accept_app_404 ?? false,
  };
}

function toAllow(raw: RawDroplet["allow"], name: string, ctx: FileCtx): AllowSpec {
  const ports = (list: string[], at: Array<string | number>) =>
    list.map((p, j) => value(ctx, [...at, j], () => parsePort(p))).filter((x) => x !== undefined);
  const droplet = (raw?.droplet ?? []).map((d, i) => {
    if (d.from === name) ctx.err(["allow", "droplet", i, "from"], "a droplet can't list itself as a caller");
    return { from: d.from, ports: ports(d.ports, ["allow", "droplet", i, "ports"]), ...(d.note ? { note: d.note } : {}) };
  });
  const routes = new Set<string>();
  const tunnel = (raw?.tunnel ?? []).flatMap((t, i) => {
    if (isReserved(t.route)) ctx.err(["allow", "tunnel", i, "route"], `${t.route}: names starting with ${RESERVED_PREFIXES.join(" or ")} are generated by the tool`);
    if (routes.has(t.route)) ctx.err(["allow", "tunnel", i, "route"], `duplicate tunnel route ${t.route}`);
    routes.add(t.route);
    const port = value(ctx, ["allow", "tunnel", i, "port"], () => parsePort(t.port));
    const who = t.who.map((w, j) => value(ctx, ["allow", "tunnel", i, "who", j], () => parseWho(w))).filter((x) => x !== undefined);
    if (port && port.from !== port.to) ctx.err(["allow", "tunnel", i, "port"], "a tunnel route takes one port, not a range");
    return port ? [{ route: t.route, port, who, ...(t.note ? { note: t.note } : {}) }] : [];
  });
  const ip = (raw?.ip ?? []).flatMap((x, i) => {
    const from = value(ctx, ["allow", "ip", i, "from"], () => parseCidr(x.from));
    return from ? [{ from, ports: ports(x.ports, ["allow", "ip", i, "ports"]), ...(x.note ? { note: x.note } : {}) }] : [];
  });
  return { droplet, tunnel, ip };
}

function toDroplet(raw: RawDroplet, ctx: FileCtx): DropletFile {
  const web = raw.web ? toWeb(raw.web, raw.name, ctx) : undefined;

  let monitors: MonitorSpec[] | undefined;
  if (raw.monitors) {
    const siteHosts = new Set(web ? [raw.name, ...web.hostnames] : []);
    monitors = raw.monitors.map((m, i) => {
      if (!siteHosts.has(m.hostname)) {
        ctx.err(["monitors", i, "hostname"], web ? `${m.hostname} is not one of this droplet's site hostnames` : "monitors need a web section");
      }
      return {
        type: m.type ?? "http",
        hostname: m.hostname,
        ...(m.path !== undefined ? { path: m.path } : {}),
        ...(m.accept_app_404 !== undefined ? { accept_app_404: m.accept_app_404 } : {}),
      };
    });
  }

  return {
    name: raw.name,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.profile !== undefined ? { profile: raw.profile } : {}),
    ...(raw.env !== undefined ? { env: raw.env } : {}),
    deploy: raw.deploy ?? false,
    frozen: raw.frozen ?? false,
    ssh: [...raw.ssh],
    ...(web ? { web } : {}),
    ...(monitors ? { monitors } : {}),
    allow: toAllow(raw.allow, raw.name, ctx),
    ...(raw.swarm
      ? { swarm: { cluster: raw.swarm.cluster, role: raw.swarm.role ?? "worker", encrypted_overlay: raw.swarm.encrypted_overlay ?? false } }
      : {}),
  };
}
