// The run report: everything one run of check / apply / drift found and did. The engine
// fills it; src/output renders it (PR comment, log line, Telegram, drift report).

import type { Diagnostic } from "./diagnostics.js";
import type { ApplyResult, ModuleName, ModulePlan, OpCounts, RunMode } from "./plan.js";
import { countOps } from "./plan.js";

export type StageStatus = "ok" | "failed" | "skipped" | "not-implemented";

export interface StageResult {
  /** e.g. "load", "checks", "observe droplets", "plan cloudflare", "apply cloudflare". */
  stage: string;
  status: StageStatus;
  /** Error text without secrets. Goes to the detail file only. */
  error?: string;
}

export interface CredentialStatus {
  /** e.g. "INFRA_GH_TOKEN". */
  name: string;
  /** ISO date the credential expires, when the API says so. */
  expiresAt?: string;
}

export interface UnmanagedDroplet {
  id: number;
  name: string;
  region: string;
}

export interface RunReport {
  mode: RunMode | "validate";
  /** The infra commit the run was pinned to, if given (--commit). */
  infraCommit?: string;
  startedAt: string;
  finishedAt?: string;
  /** Number of droplet files loaded. */
  dropletFiles: number;
  stages: StageResult[];
  diagnostics: Diagnostic[];
  plans: ModulePlan[];
  applied: ApplyResult[];
  /** Droplets with no file (reported, left alone). */
  unmanaged: UnmanagedDroplet[];
  credentials: CredentialStatus[];
}

export interface ReportCounts extends OpCounts {
  errors: number;
  warnings: number;
  unmanaged: number;
  applied: number;
  failed: number;
  dropletFiles: number;
}

export function newReport(mode: RunReport["mode"], now: Date, infraCommit?: string): RunReport {
  return {
    mode,
    ...(infraCommit ? { infraCommit } : {}),
    startedAt: now.toISOString(),
    dropletFiles: 0,
    stages: [],
    diagnostics: [],
    plans: [],
    applied: [],
    unmanaged: [],
    credentials: [],
  };
}

export function reportCounts(r: RunReport): ReportCounts {
  const ops = countOps(r.plans.flatMap((p) => p.ops));
  const all = [...r.diagnostics, ...r.plans.flatMap((p) => p.diagnostics)];
  return {
    ...ops,
    errors: all.filter((d) => d.level === "error").length + r.stages.filter((s) => s.status === "failed" || s.status === "not-implemented").length,
    warnings: all.filter((d) => d.level === "warning").length,
    unmanaged: r.unmanaged.length,
    applied: r.applied.reduce((n, a) => n + a.applied.length, 0),
    failed: r.applied.reduce((n, a) => n + a.failed.length, 0),
    dropletFiles: r.dropletFiles,
  };
}

/** Pass: no error diagnostics, no failed or unimplemented stage, no failed apply op. */
export function reportPassed(r: RunReport): boolean {
  const c = reportCounts(r);
  return c.errors === 0 && c.failed === 0;
}

export function planOf(r: RunReport, module: ModuleName): ModulePlan | undefined {
  return r.plans.find((p) => p.module === module);
}
