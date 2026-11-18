// B7: everything people read. See README.md in this folder.
//
// Implemented in B0 (the CLI needs them now): renderLogLine (counts only: the one thing
// that goes to the public logs), renderBasicDetail (plain fallback detail file).
// To do in B7: renderPrComment, renderApplySummary, renderTelegram, renderDriftReport, sendTelegram.

import { formatDiagnostic, NotImplementedError, notImplemented } from "../core/diagnostics.js";
import type { PlanOp, RunContext } from "../core/plan.js";
import { reportCounts, reportPassed, type RunReport } from "../core/report.js";

/**
 * The single line printed to stdout. Counts and pass/fail ONLY: no names, hostnames, IPs,
 * ids, paths inside the checkout or error text. This is what the public Actions log shows.
 */
export function renderLogLine(r: RunReport): string {
  const c = reportCounts(r);
  const notImpl = r.stages.filter((s) => s.status === "not-implemented").length;
  const failedStages = r.stages.filter((s) => s.status === "failed").length;
  const parts = [
    `infra ${r.mode}: ${reportPassed(r) ? "PASS" : "FAIL"}`,
    `droplet files ${c.dropletFiles}`,
    `plan create ${c.create} update ${c.update} delete ${c.delete} report ${c.report}`,
    `errors ${c.errors} warnings ${c.warnings}`,
    `unmanaged droplets ${c.unmanaged}`,
  ];
  if (r.mode === "apply") parts.push(`applied ${c.applied} failed ${c.failed}`);
  if (failedStages) parts.push(`failed stages ${failedStages}`);
  if (notImpl) parts.push(`stages not implemented ${notImpl}`);
  return parts.join(" | ");
}

const opLine = (op: PlanOp): string =>
  `| ${op.action} | ${op.provider} | ${op.kind} | \`${op.key}\` | ${op.droplet ?? ""} | ${op.reason.replace(/\|/g, "\\|")} |`;

/**
 * Plain markdown with everything in the report: stages, diagnostics, every op. Used for the
 * detail file until B7's renderers exist, and as their fallback.
 */
export function renderBasicDetail(r: RunReport): string {
  const c = reportCounts(r);
  const out: string[] = [
    `# infra ${r.mode}: ${reportPassed(r) ? "pass" : "FAIL"}`,
    "",
    ...(r.infraCommit ? [`infra commit: \`${r.infraCommit}\``, ""] : []),
    `Droplet files: ${c.dropletFiles}. Plan: ${c.create} create, ${c.update} update, ${c.delete} delete, ${c.report} report-only. ` +
      `Errors: ${c.errors}. Warnings: ${c.warnings}. Droplets with no file: ${c.unmanaged}.`,
    "",
    "## Stages",
    "",
    ...r.stages.map((s) => `- ${s.stage}: ${s.status}${s.error ? ` (${s.error})` : ""}`),
  ];
  const diags = [...r.diagnostics, ...r.plans.flatMap((p) => p.diagnostics)];
  if (diags.length) out.push("", "## Diagnostics", "", ...diags.map((d) => `- ${formatDiagnostic(d)}`));
  for (const p of r.plans) {
    out.push("", `## ${p.module}: ${p.ops.length} op(s), ${p.unchanged} unchanged`);
    if (p.ops.length) out.push("", "| action | provider | kind | key | droplet | reason |", "|---|---|---|---|---|---|", ...p.ops.map(opLine));
  }
  for (const a of r.applied) {
    out.push("", `## applied ${a.module}: ${a.applied.length} done, ${a.failed.length} failed, ${a.skipped.length} skipped`);
    for (const f of a.failed) out.push(`- FAILED ${f.op.kind} \`${f.op.key}\`: ${f.error}`);
  }
  if (r.unmanaged.length) out.push("", "## Droplets with no file", "", ...r.unmanaged.map((d) => `- ${d.name} (${d.region}, id ${d.id})`));
  if (r.credentials.length) out.push("", "## Credentials", "", ...r.credentials.map((x) => `- ${x.name}: expires ${x.expiresAt ?? "unknown"}`));
  return out.join("\n") + "\n";
}

/** B7. The PR comment for `check`: "what happens if this is merged", counts first, then detail grouped by droplet. */
export function renderPrComment(_r: RunReport): string {
  return notImplemented("output.renderPrComment");
}

/** B7. The detail file after `apply`: what was done, what failed, what was skipped (frozen, report-only). */
export function renderApplySummary(_r: RunReport): string {
  return notImplemented("output.renderApplySummary");
}

/** B7. The daily drift report: droplets with no file, hand-made changes (the plan's ops), credential expiry. */
export function renderDriftReport(_r: RunReport): string {
  return notImplemented("output.renderDriftReport");
}

/** B7. Telegram messages (HTML, each under 4096 chars) summarising an apply or a drift run. */
export function renderTelegram(_r: RunReport): string[] {
  return notImplemented("output.renderTelegram");
}

/** B7. Sends the messages to account.telegram.chat_id with TELEGRAM_BOT_TOKEN (ctx.fetch). */
export async function sendTelegram(_ctx: RunContext, _messages: string[]): Promise<void> {
  return notImplemented("output.sendTelegram");
}

/** The detail file for a run: B7's renderer for the mode, or renderBasicDetail until it exists. */
export function renderDetail(r: RunReport): string {
  try {
    if (r.mode === "check") return renderPrComment(r);
    if (r.mode === "apply") return renderApplySummary(r);
    if (r.mode === "drift") return renderDriftReport(r);
  } catch (e) {
    if (!(e instanceof NotImplementedError)) throw e;
  }
  return renderBasicDetail(r);
}
