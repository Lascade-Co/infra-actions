// Shared pieces of the B7 renderers: how ops are grouped, labelled and summarised.
// Nothing here renders op.ids (they carry provider ids and the ssh config text).

import { KNOWN_AFTER_CREATE } from "../core/constants.js";
import { formatDiagnostic, type Diagnostic } from "../core/diagnostics.js";
import type { Json, PlanOp, ProviderName, ResourceKind } from "../core/plan.js";
import type { CredentialStatus, RunReport, StageResult } from "../core/report.js";

/** The drift report and Telegram warn when a credential expires within this many days. */
export const EXPIRY_WARN_DAYS = 30;

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  digitalocean: "DigitalOcean",
  cloudflare: "Cloudflare",
  oneuptime: "OneUptime",
  github: "GitHub",
};
export const PROVIDER_ORDER: ProviderName[] = ["digitalocean", "cloudflare", "oneuptime", "github"];

/** Readable names per kind, in the order groups are shown. */
export const KIND_LABEL: Record<ResourceKind, string> = {
  droplet: "Droplets",
  "droplet-tags": "Droplet tags",
  "infra-target": "SSH targets",
  "infra-app": "SSH Access apps",
  "access-app": "Site Access apps",
  "tunnel-ingress": "Tunnel routes",
  "dns-record": "DNS records",
  monitor: "Monitors",
  "ssh-config": "ssh config",
  firewall: "Firewalls",
  "firewall-rule": "Firewall rules",
};
const KIND_ORDER = Object.keys(KIND_LABEL) as ResourceKind[];

export const allOps = (r: RunReport): PlanOp[] => r.plans.flatMap((p) => p.ops);
export const allDiagnostics = (r: RunReport): Diagnostic[] => [...r.diagnostics, ...r.plans.flatMap((p) => p.diagnostics)];

/** Report-only ops split the way people read them. */
export const isFirewallReport = (op: PlanOp): boolean => op.action === "report" && op.module === "firewall";
export const isFrozenReport = (op: PlanOp): boolean => op.action === "report" && !isFirewallReport(op) && op.reason.startsWith("frozen droplet");
export const isOtherReport = (op: PlanOp): boolean => op.action === "report" && !isFirewallReport(op) && !isFrozenReport(op);

/** Stages that failed or aren't implemented: errors. */
export const brokenStages = (r: RunReport): StageResult[] => r.stages.filter((s) => s.status === "failed" || s.status === "not-implemented");

export interface ApplyStop {
  /** The engine's reason. */
  reason: string;
  /**
   * true: something may have been written before it stopped: ops were applied (e.g. droplets were
   * created, then re-planning failed), or a module's apply threw part-way (what it wrote is unknown).
   */
  partial: boolean;
  /** Planned changes that were neither applied nor failed. */
  notApplied: PlanOp[];
}

const opId = (op: PlanOp) => `${op.provider} ${op.kind} ${op.key}`;

/** Set when the engine stopped the apply (a skipped "apply" stage): before anything, or part-way. */
export function applyStopped(r: RunReport): ApplyStop | undefined {
  const s = r.stages.find((x) => x.stage === "apply" && x.status === "skipped");
  if (!s) return undefined;
  const done = new Set(r.applied.flatMap((a) => [...a.applied, ...a.failed.map((f) => f.op)]).map(opId));
  const applied = r.applied.reduce((n, a) => n + a.applied.length + a.failed.length, 0);
  const threw = r.stages.some((x) => x.stage.startsWith("apply ") && x.status === "failed");
  return {
    reason: s.error ?? "apply was skipped",
    partial: applied > 0 || threw,
    notApplied: allOps(r).filter((op) => op.action !== "report" && !done.has(opId(op))),
  };
}

/** The time a report is about: when it finished, or (while the engine is still finishing it) started. */
export const reportTime = (r: RunReport): Date => new Date(r.finishedAt ?? r.startedAt);

/** Groups by a key, keeping first-seen order. */
export function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const cur = m.get(k);
    if (cur) cur.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Ops per droplet (sorted by name), then the ones not tied to a droplet under "". */
export function byDroplet(ops: readonly PlanOp[]): Array<[string, PlanOp[]]> {
  const g = groupBy(ops, (op) => op.droplet ?? "");
  const named = [...g].filter(([k]) => k).sort(([a], [b]) => a.localeCompare(b));
  const shared = g.get("");
  return shared ? [...named, ["", shared]] : named;
}

/** Ops per kind, in KIND_LABEL order. */
export function byKind(ops: readonly PlanOp[]): Array<[ResourceKind, PlanOp[]]> {
  const g = groupBy(ops, (op) => op.kind);
  return KIND_ORDER.filter((k) => g.has(k)).map((k) => [k, g.get(k)!]);
}

/** A short label for an op's object, for lists. */
export function opLabel(op: PlanOp): string {
  if (op.kind === "tunnel-ingress") {
    const m = op.key.match(/^(\S+) (.+)$/);
    if (m) return `${m[2]} (tunnel ${m[1]!.slice(0, 8)})`;
  }
  if (op.kind === "ssh-config") {
    const after = op.after as { hosts?: unknown } | null;
    if (after && typeof after.hosts === "number") return `ssh config (${after.hosts} hosts)`;
  }
  return op.key;
}

/** Compact JSON with KNOWN_AFTER_CREATE shown bare. */
export function compactJson(v: Json | null | undefined): string {
  if (v === undefined) return "";
  return JSON.stringify(v).split(JSON.stringify(KNOWN_AFTER_CREATE)).join(KNOWN_AFTER_CREATE);
}

const isObject = (v: Json | null): v is { [k: string]: Json } => v !== null && typeof v === "object" && !Array.isArray(v);

/** "before → after", or for two objects only the fields that change ("a: 1 → 2; b: x → y"). */
const isEmpty = (v: Json | null | undefined): boolean =>
  v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

export function changeText(op: PlanOp): string {
  const { before, after } = op;
  if (isEmpty(before) && isEmpty(after)) return "";
  if (before === null) return `→ ${compactJson(after)}`;
  if (after === null) return `${compactJson(before)} → (deleted)`;
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const diffs = keys
      .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
      // A field only `after` has, and that is empty (e.g. removed: []), says nothing.
      .filter((k) => k in before || !isEmpty(after[k]))
      .map((k) => `${k}: ${k in before ? compactJson(before[k]) : "(none)"} → ${k in after ? compactJson(after[k]) : "(none)"}`);
    if (diffs.length) return diffs.join("; ");
  }
  return `${compactJson(before)} → ${compactJson(after)}`;
}

export interface CredentialCheck {
  name: string;
  level: "error" | "warning" | "ok" | "unknown";
  /** e.g. "expires 2026-12-01 (in 12 days)". */
  text: string;
  days?: number;
}

const DAY_MS = 86_400_000;

export function checkCredential(c: CredentialStatus, now: Date, warnDays = EXPIRY_WARN_DAYS): CredentialCheck {
  const exp = c.expiresAt ? new Date(c.expiresAt) : undefined;
  if (!exp || Number.isNaN(exp.getTime())) return { name: c.name, level: "unknown", text: "expiry unknown" };
  const days = Math.floor((exp.getTime() - now.getTime()) / DAY_MS);
  const date = exp.toISOString().slice(0, 10);
  if (exp.getTime() <= now.getTime()) return { name: c.name, level: "error", text: `expired on ${date}`, days };
  const when = days === 0 ? "today" : days === 1 ? "in 1 day" : `in ${days} days`;
  return { name: c.name, level: days < warnDays ? "warning" : "ok", text: `expires on ${date} (${when})`, days };
}

export const credentialChecks = (r: RunReport): CredentialCheck[] => r.credentials.map((c) => checkCredential(c, reportTime(r)));

export { formatDiagnostic };
