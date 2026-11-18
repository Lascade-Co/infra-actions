#!/usr/bin/env node
// infra: command-line entry point.
//
//   infra validate <infra-dir>              load + schema only (no API calls, no secrets)
//   infra check    <infra-dir> [--base <dir>]  validate, checks, plan; read-only
//   infra apply    <infra-dir> [--base <dir>]  plan, then apply (the only command that writes);
//                                           all-or-nothing: any error and nothing is written
//   infra drift    <infra-dir>              read-only: droplets with no file, hand-made changes
//
// Options:
//   --out <file>   the detail report (markdown): the PR comment for check, the apply summary,
//                  the drift report. Written only when given; there is no default path.
//   --json <file>  the full report as JSON, including each op's provider ids and the rendered
//                  ssh config. Written only when given.
//   --base <dir>   a checkout to compare with (checkChange): the PR's base for check, the commit
//                  main was at before the push for apply.
//   --commit <sha> the infra commit this run is pinned to.
//
// DETAIL FILES ARE NEVER UPLOADED (decision 7). The --out and --json files hold real names,
// hostnames, IPs and ids, and the --json file also the provider ids and the ssh config. A
// workflow must write them outside the checkout (e.g. under $RUNNER_TEMP), post the --out file
// only as the comment on the private infra pull request (or to Telegram), and never pass either
// to actions/upload-artifact, a cache, a job summary or the log. Workflow runs of this public
// repo are visible to the org; artifacts would be too. That is why the CLI writes them only to a
// path given on the command line and never picks a default location.
//
// OUTPUT RULE (this repo is public, so are its Actions logs): stdout gets exactly one line of
// counts and pass/fail; stderr gets at most a generic message. Names, hostnames, IPs, ids and
// error text go only to the --out / --json files. Secrets come only from environment variables.
// Without --out, a failed run says only that the details were not written.

import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { runEngine, type EngineOptions } from "./engine.js";
import { Secrets } from "./core/secrets.js";
import { renderDetail, renderLogLine } from "./output/index.js";
import { reportPassed } from "./core/report.js";

export const USAGE = "usage: infra <validate|check|apply|drift> <infra-dir> [--out <file>] [--json <file>] [--commit <sha>] [--base <dir>]";
const COMMANDS = ["validate", "check", "apply", "drift"] as const;
type Command = (typeof COMMANDS)[number];

export interface CliArgs {
  command: Command;
  infraDir: string;
  /** Detail report path. Only ever a path given on the command line (see DETAIL FILES above). */
  out?: string;
  /** Full JSON report path. Only ever a path given on the command line. */
  json?: string;
  commit?: string;
  base?: string;
}

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) return { error: USAGE };
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (!["out", "json", "commit", "base"].includes(name)) return { error: `unknown option --${name}\n${USAGE}` };
      const v = rest[++i];
      if (v === undefined) return { error: `--${name} needs a value\n${USAGE}` };
      flags[name] = v;
    } else positional.push(a);
  }
  if (positional.length !== 1) return { error: USAGE };
  if (flags.base && command !== "check" && command !== "apply") return { error: `--base is only for check and apply\n${USAGE}` };
  if (flags.commit && !/^[0-9a-f]{7,40}$/.test(flags.commit)) return { error: "--commit must be a git sha" };
  return {
    command: command as Command,
    infraDir: positional[0]!,
    ...(flags.out ? { out: flags.out } : {}),
    ...(flags.json ? { json: flags.json } : {}),
    ...(flags.commit ? { commit: flags.commit } : {}),
    ...(flags.base ? { base: flags.base } : {}),
  };
}

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  fetch: EngineOptions["fetch"];
  /** Injectable for tests. */
  modules?: EngineOptions["modules"];
  now?: EngineOptions["now"];
  sleep?: EngineOptions["sleep"];
}

/** Returns the exit code: 0 pass, 1 fail, 2 usage. */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    io.stderr(args.error);
    return 2;
  }
  const secrets = new Secrets(io.env);
  try {
    const report = await runEngine({
      mode: args.command,
      infraDir: args.infraDir,
      ...(args.base ? { baseDir: args.base } : {}),
      ...(args.commit ? { infraCommit: args.commit } : {}),
      env: io.env,
      fetch: io.fetch,
      ...(io.modules ? { modules: io.modules } : {}),
      ...(io.now ? { now: io.now } : {}),
      ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    if (args.out) await writeFile(args.out, secrets.redact(renderDetail(report)));
    if (args.json) await writeFile(args.json, secrets.redact(JSON.stringify(report, null, 2)) + "\n");
    io.stdout(secrets.redact(renderLogLine(report)));
    const passed = reportPassed(report);
    if (!passed && !args.out && !args.json) io.stderr(`infra ${args.command}: details not written; pass --out <file> to see them`);
    return passed ? 0 : 1;
  } catch (e) {
    // Never print the error itself: it may name droplets or hosts. Put it in the detail file.
    const text = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    if (!args.out) {
      io.stderr(`infra ${args.command}: internal error; pass --out <file> to see the details`);
      return 1;
    }
    try {
      await writeFile(args.out, secrets.redact(`# infra ${args.command}: internal error\n\n\`\`\`\n${text}\n\`\`\`\n`));
      io.stderr(`infra ${args.command}: internal error; details in the --out file`);
    } catch {
      io.stderr(`infra ${args.command}: internal error; the --out file could not be written`);
    }
    return 1;
  }
}

function invokedDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

const isEntry = invokedDirectly();
if (isEntry) {
  const code = await main(process.argv.slice(2), {
    stdout: (l) => process.stdout.write(l + "\n"),
    stderr: (l) => process.stderr.write(l + "\n"),
    env: process.env,
    fetch: (input, init) => fetch(input, init),
  });
  process.exitCode = code;
}
