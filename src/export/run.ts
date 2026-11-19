// `infra export`: reads the inputs, runs buildExport and writes the files.
//
//   infra export <out-dir> --worker <wrangler.toml> --web-config <web-config.json>
//                [--droplets <droplets.json>] [--account-base <account.yaml>] [--drafts <drafts.yaml>]
//                [--frozen <name,...>] [--include-untagged] [--out <notes.md>] [--date <yyyy-mm-dd>]
//
// - Droplets: from --droplets (the API's droplet objects, e.g. `doctl compute droplet list -o json`,
//   as an array or { droplets: [...] }), else read from DigitalOcean with DO_TOKEN (read-only).
// - Zones: from Cloudflare with CF_API_TOKEN when it is set (read-only), else the account base.
// - Account base: --account-base, else <out-dir>/account.yaml (so a re-export keeps its values).
// - Writes <out-dir>/account.yaml and <out-dir>/droplets/<name>.yaml, and removes any other
//   droplets/*.yaml (a re-export mirrors the live state). Nothing else in <out-dir> is touched.
// - stdout: one line of counts. The notes (real names) go only to --out.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { CfClient } from "../cloudflare/client.js";
import { doClient, listAllDroplets } from "../droplets/api.js";
import { toObservedDroplet } from "../droplets/index.js";
import type { FetchFn } from "../core/http.js";
import { ACCOUNT_FILE, DROPLETS_DIR } from "../core/loader.js";
import type { ObservedDroplet } from "../core/observed.js";
import { Secrets } from "../core/secrets.js";
import { buildExport, ExportError, renderNotes } from "./index.js";

export const EXPORT_USAGE =
  "usage: infra export <out-dir> --worker <wrangler.toml> --web-config <web-config.json> [--droplets <file>] " +
  "[--account-base <file>] [--drafts <file>] [--frozen <name,...>] [--include-untagged] [--out <notes.md>] [--date <yyyy-mm-dd>]";

export interface ExportArgs {
  outDir: string;
  worker: string;
  webConfig: string;
  droplets?: string;
  accountBase?: string;
  drafts?: string;
  frozen: string[];
  includeUntagged: boolean;
  out?: string;
  date?: string;
}

const VALUE_FLAGS = ["worker", "web-config", "droplets", "account-base", "drafts", "frozen", "out", "date"];

export function parseExportArgs(argv: readonly string[]): ExportArgs | { error: string } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let includeUntagged = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--include-untagged") includeUntagged = true;
    else if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!VALUE_FLAGS.includes(name)) return { error: `unknown option --${name}\n${EXPORT_USAGE}` };
      const v = argv[++i];
      if (v === undefined) return { error: `--${name} needs a value\n${EXPORT_USAGE}` };
      flags[name] = v;
    } else positional.push(a);
  }
  if (positional.length !== 1 || !flags.worker || !flags["web-config"]) return { error: EXPORT_USAGE };
  if (flags.date && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) return { error: "--date must be yyyy-mm-dd" };
  return {
    outDir: positional[0]!,
    worker: flags.worker,
    webConfig: flags["web-config"],
    ...(flags.droplets ? { droplets: flags.droplets } : {}),
    ...(flags["account-base"] ? { accountBase: flags["account-base"] } : {}),
    ...(flags.drafts ? { drafts: flags.drafts } : {}),
    frozen: (flags.frozen ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    includeUntagged,
    ...(flags.out ? { out: flags.out } : {}),
    ...(flags.date ? { date: flags.date } : {}),
  };
}

/**
 * The [vars] table of a wrangler.toml: KEY = "basic string" or 'literal string', one per line.
 * Enough for the Worker's file; anything else in [vars] is an error rather than a guess.
 */
export function parseWranglerVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inVars = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(".*"|'.*')\s*(#.*)?$/.exec(line);
    if (!m) throw new ExportError(`wrangler.toml [vars]: can't read the line for ${line.split("=")[0]!.trim()}`);
    const v = m[2]!;
    if (v.startsWith("'")) {
      out[m[1]!] = v.slice(1, -1);
    } else {
      try {
        out[m[1]!] = JSON.parse(v) as string;
      } catch {
        throw new ExportError(`wrangler.toml [vars]: ${m[1]} is not a valid string`);
      }
    }
  }
  return out;
}

export interface ExportIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  now?: () => Date;
}

async function readDroplets(args: ExportArgs, io: ExportIO, secrets: Secrets): Promise<ObservedDroplet[]> {
  if (args.droplets) {
    const raw = JSON.parse(await readFile(args.droplets, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { droplets?: unknown }).droplets;
    if (!Array.isArray(list) || !list.length) throw new ExportError("the droplets file has no droplets");
    // doctl's JSON leaves out "tags" when a droplet has none (the API always sends []).
    const droplets = list.map((d: unknown) => toObservedDroplet(typeof d === "object" && d !== null && !("tags" in d) ? { ...d, tags: [] } : d));
    if (droplets.every((d) => d.tags.length === 0)) throw new ExportError("no droplet in the droplets file has a tag (was it read without tag:read?)");
    return droplets;
  }
  if (!secrets.has("DO_TOKEN")) throw new ExportError("give --droplets <file> or set DO_TOKEN");
  const api = doClient({ secrets, fetch: io.fetch, allowWrites: false });
  return (await listAllDroplets(api)).map(toObservedDroplet);
}

/** Returns the exit code: 0 written, 1 failed, 2 usage. */
export async function runExport(argv: readonly string[], io: ExportIO): Promise<number> {
  const args = parseExportArgs(argv);
  if ("error" in args) {
    io.stderr(args.error);
    return 2;
  }
  const secrets = new Secrets(io.env);
  try {
    const vars = parseWranglerVars(await readFile(args.worker, "utf8"));
    const webConfig = JSON.parse(await readFile(args.webConfig, "utf8")) as unknown;
    const basePath = args.accountBase ?? join(args.outDir, ACCOUNT_FILE);
    let base: Record<string, unknown>;
    try {
      base = (parse(await readFile(basePath, "utf8")) as Record<string, unknown> | null) ?? {};
    } catch (e) {
      if (args.accountBase) throw e;
      throw new ExportError("no account base: give --account-base, or run it on a checkout that has account.yaml");
    }
    const drafts = args.drafts ? (parse(await readFile(args.drafts, "utf8")) as unknown) : undefined;
    const droplets = await readDroplets(args, io, secrets);
    let zones: string[] | undefined;
    if (secrets.has("CF_API_TOKEN")) {
      const cf = CfClient.create({ token: secrets.require("CF_API_TOKEN"), accountId: vars.CF_ACCOUNT_ID ?? "", fetch: io.fetch, allowWrites: false });
      zones = (await cf.listZones()).map((z) => z.name.toLowerCase());
    }
    const date = args.date ?? (io.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const { files, notes } = buildExport({
      droplets,
      vars,
      webConfig,
      base,
      ...(zones ? { zones } : {}),
      ...(drafts !== undefined ? { drafts } : {}),
      frozen: args.frozen,
      includeUntagged: args.includeUntagged,
      date,
    });
    const unknownFrozen = args.frozen.filter((n) => !notes.written.includes(n));
    if (unknownFrozen.length) notes.warnings.push(`--frozen names droplets that got no file: ${unknownFrozen.join(", ")}`);

    // Write: account.yaml and droplets/, removing droplet files the export no longer produces.
    const dropletsDir = join(args.outDir, DROPLETS_DIR);
    await mkdir(dropletsDir, { recursive: true });
    let removed = 0;
    for (const name of await readdir(dropletsDir)) {
      if (name.endsWith(".yaml") && files[`${DROPLETS_DIR}/${name}`] === undefined) {
        await rm(join(dropletsDir, name));
        removed++;
      }
    }
    for (const [rel, text] of Object.entries(files)) await writeFile(join(args.outDir, rel), text);
    if (args.out) await writeFile(args.out, secrets.redact(renderNotes(notes)));
    io.stdout(
      `infra export: droplet files ${notes.written.length} | left out ${notes.leftOut.length} | not managed ${notes.notManaged.length}` +
        ` | web entries not written ${notes.webNotWritten.length} | drafts dropped ${notes.draftsDropped.length}` +
        ` | warnings ${notes.warnings.length} | stale files removed ${removed}`,
    );
    return 0;
  } catch (e) {
    // The message may name droplets or hosts: only into the --out file.
    const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (args.out) {
      try {
        await writeFile(args.out, secrets.redact(`# infra export: failed\n\n${text}\n`));
        io.stderr("infra export: failed; details in the --out file");
        return 1;
      } catch {
        // fall through
      }
    }
    io.stderr("infra export: failed; pass --out <file> to see the details");
    return 1;
  }
}
