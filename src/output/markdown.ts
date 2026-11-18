// Markdown renderers: the PR comment (check), the apply summary and the daily drift report.
// They go to the detail file (--out), which the workflow posts on the private infra repo.

import type { Diagnostic } from "../core/diagnostics.js";
import { countOps, isChange, type PlanOp } from "../core/plan.js";
import { reportCounts, reportPassed, type RunReport } from "../core/report.js";
import {
  allDiagnostics,
  allOps,
  applyStopped,
  brokenStages,
  byDroplet,
  changeText,
  credentialChecks,
  EXPIRY_WARN_DAYS,
  groupBy,
  isFirewallReport,
  isFrozenReport,
  isOtherReport,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  reportTime,
} from "./common.js";

/** First line of every PR comment; the workflow finds and updates its own comment by it. */
export const PR_COMMENT_MARKER = "<!-- infra-actions:plan -->";
/** GitHub rejects comments over 65,536 characters; keep a margin. */
export const PR_COMMENT_MAX = 60_000;
/** Longest error or warning text shown (each). */
const MESSAGE_MAX = 1_000;
/** A change longer than this goes in a collapsed block. */
const INLINE_CHANGE_MAX = 160;

// ---------- escaping ----------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain text in markdown: no HTML (it could close our <details>), no @mentions. */
export const mdText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "@​");

/** An inline code span. Backticks inside become quotes. */
export const code = (s: string): string => `\`${s.replace(/`/g, "'").replace(/\n/g, " ")}\``;

// ---------- size budget ----------

/**
 * Builds a markdown document under a size limit. `always` parts are never cut (counts,
 * errors). Sections are added whole items at a time; items that don't fit are counted and
 * a note says how many were left out. A section is always closed, so no <details> stays open.
 */
class Doc {
  private readonly parts: string[] = [];
  private used = 0;
  omitted = 0;
  private static readonly NOTE_RESERVE = 300;

  constructor(private readonly limit = Number.POSITIVE_INFINITY) {}

  always(...lines: string[]) {
    for (const l of lines) {
      this.parts.push(l);
      this.used += l.length + 1;
    }
  }

  private fits(n: number): boolean {
    return this.used + n + Doc.NOTE_RESERVE <= this.limit;
  }

  section(open: string, items: string[], close = "") {
    if (!items.length) return;
    if (!this.fits(open.length + 1 + items[0]!.length + 1 + close.length + 1)) {
      this.omitted += items.length;
      return;
    }
    if (open) this.always(open);
    let i = 0;
    for (; i < items.length; i++) {
      const it = items[i]!;
      if (!this.fits(it.length + 1 + close.length + 1)) break;
      this.always(it);
    }
    this.omitted += items.length - i;
    if (close) this.always(close);
  }

  text(): string {
    const out = [...this.parts];
    if (this.omitted) out.push("", `> **Detail truncated:** ${this.omitted} more item(s) not shown (comment size limit). The counts and errors above are complete.`);
    return out.join("\n") + "\n";
  }
}

// ---------- pieces ----------

const diagLine = (d: Diagnostic): string => {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "";
  const loc = [where ? code(where) : "", d.path ? code(d.path) : ""].filter(Boolean).join(" ");
  return `- ${loc ? `${loc}: ` : ""}${mdText(clip(d.message, MESSAGE_MAX))}`;
};

/** One op as a list item; a long change goes in a collapsed block under it. */
export function opItem(op: PlanOp, opts: { action?: boolean; provider?: boolean } = {}): string {
  const head = [
    opts.action === false ? "" : `**${op.action}**`,
    opts.provider ? PROVIDER_LABEL[op.provider] : "",
    op.kind,
    code(op.key),
  ]
    .filter(Boolean)
    .join(" ");
  const change = changeText(op);
  const line = `- ${head}: ${mdText(op.reason)}`;
  if (!change) return line;
  if (change.length <= INLINE_CHANGE_MAX) return `${line}<br>${code(change)}`;
  return [
    line,
    "  <details><summary>before → after</summary>",
    "",
    "  ```",
    `  ${change.replace(/```/g, "'''").replace(/\n/g, "\n  ")}`,
    "  ```",
    "",
    "  </details>",
  ].join("\n");
}

const countsTable = (ops: PlanOp[], unchanged: number): string[] => {
  const rows = PROVIDER_ORDER.flatMap((p) => {
    const c = countOps(ops.filter((op) => op.provider === p));
    return c.create + c.update + c.delete + c.report ? [`| ${PROVIDER_LABEL[p]} | ${c.create} | ${c.update} | ${c.delete} | ${c.report} |`] : [];
  });
  if (!rows.length) return [`No changes. ${unchanged} object(s) already match the droplet files.`];
  const t = countOps(ops);
  return [
    "| | create | update | delete | report only |",
    "|---|---:|---:|---:|---:|",
    ...rows,
    `| **total** | **${t.create}** | **${t.update}** | **${t.delete}** | **${t.report}** |`,
    "",
    `${unchanged} other object(s) already match the droplet files.`,
  ];
};

const stageLines = (r: RunReport, which: "broken" | "all-not-ok"): string[] =>
  (which === "broken" ? brokenStages(r) : r.stages.filter((s) => s.status !== "ok")).map(
    (s) => `- ${s.stage}: **${s.status}**${s.error ? `: ${mdText(clip(s.error, MESSAGE_MAX))}` : ""}`,
  );

/** Errors (never cut): error diagnostics and stages that failed or aren't implemented. */
function errorsSection(doc: Doc, r: RunReport, extra: string[] = []) {
  const errors = allDiagnostics(r).filter((d) => d.level === "error");
  const stages = stageLines(r, "broken");
  const n = errors.length + stages.length + extra.length;
  if (!n) return;
  doc.always("", `### ❌ Errors (${n})`, "", ...extra, ...errors.map(diagLine));
  if (stages.length) doc.always(...(errors.length || extra.length ? [""] : []), "Stages that did not run:", "", ...stages);
}

/**
 * Warnings people must act on, each under its own heading and never cut for size (there is at
 * most one per droplet or route). The cloudflare module's codes (src/cloudflare/plan.ts).
 */
export const WARNING_GROUPS: ReadonlyArray<{ title: string; codes: readonly string[]; intro: string }> = [
  {
    title: "Awaiting cutover",
    codes: ["cloudflare-awaiting-cutover"],
    intro: "A record the tool doesn't own still holds these names, so their site isn't routed through the tunnel yet. The cutover swaps each one in place; until then the tool leaves it alone.",
  },
  {
    title: "Held: not managed this run",
    codes: ["cloudflare-skipped", "cloudflare-conflict"],
    intro: "The tool neither changes nor deletes the Cloudflare objects of these droplets or names until the reason below is fixed.",
  },
  {
    title: "Tunnel routes not built: add them by hand",
    codes: ["cloudflare-route-not-built"],
    intro: "UDP ports and port ranges in `allow.tunnel` need a private-network route the tool does not build.",
  },
];

function warningsSections(doc: Doc, r: RunReport) {
  const ds = allDiagnostics(r);
  const warnings = ds.filter((d) => d.level === "warning");
  const infos = ds.filter((d) => d.level === "info");
  const grouped = new Set(WARNING_GROUPS.flatMap((g) => g.codes));
  const groups = WARNING_GROUPS.map((g) => ({ ...g, items: warnings.filter((d) => g.codes.includes(d.code)) })).filter((g) => g.items.length);
  const rest = warnings.filter((d) => !grouped.has(d.code));
  if (groups.length) {
    doc.always("", `### ⚠️ Warnings (${warnings.length})`);
    for (const g of groups) doc.always("", `#### ${g.title} (${g.items.length})`, "", mdText(g.intro), "", ...g.items.map(diagLine));
    doc.section(`\n#### Other warnings (${rest.length})\n`, rest.map(diagLine));
  } else {
    doc.section(`\n### ⚠️ Warnings (${warnings.length})\n`, warnings.map(diagLine));
  }
  doc.section(`\n<details><summary>Notes (${infos.length})</summary>\n`, infos.map(diagLine), "\n</details>");
}

/** Ops grouped by droplet, the shared ones last. */
function opsByDroplet(doc: Doc, title: string, ops: PlanOp[], opts: { action?: boolean; provider?: boolean; intro?: string } = {}) {
  if (!ops.length) return;
  doc.always("", `### ${title} (${ops.length})`);
  if (opts.intro) doc.always("", opts.intro);
  for (const [droplet, group] of byDroplet(ops)) {
    const heading = droplet ? `#### ${code(droplet)} (${group.length})` : `#### Shared, not tied to one droplet (${group.length})`;
    doc.section(`\n${heading}\n`, group.map((op) => opItem(op, opts)));
  }
}

function collapsed(doc: Doc, summary: string, items: string[], intro?: string) {
  doc.section(`\n<details><summary>${summary} (${items.length})</summary>\n${intro ? `\n${intro}\n` : ""}`, items, "\n</details>");
}

/** "3 to allow, 1 to narrow, 2 to remove" for a droplet's firewall report ops. */
function firewallCounts(ops: PlanOp[]): string {
  const allow = ops.filter((op) => op.before === null).length;
  const remove = ops.filter((op) => op.before !== null && op.after === null).length;
  const narrow = ops.length - allow - remove;
  return [allow ? `${allow} to allow` : "", narrow ? `${narrow} to narrow` : "", remove ? `${remove} to remove` : ""].filter(Boolean).join(", ");
}

/**
 * The firewall report is large (broad firewalls attached by tag show up on every droplet), so it is
 * one collapsed block, and inside it one collapsed block per droplet with its counts in the summary.
 */
function firewallSection(doc: Doc, ops: PlanOp[]) {
  const fw = ops.filter(isFirewallReport);
  if (!fw.length) return;
  const groups = byDroplet(fw);
  doc.always(
    "",
    `<details><summary>Firewall rules: report only, not enforced until Phase 5 (${fw.length} on ${groups.length} droplet(s))</summary>`,
    "",
    "What the `allow:` and `swarm:` sections imply for the DigitalOcean firewalls, per droplet. Nothing here is applied.",
  );
  for (const [droplet, group] of groups) {
    const name = droplet ? code(droplet) : "Not tied to one droplet";
    doc.section(`\n<details><summary>${name}: ${firewallCounts(group)}</summary>\n`, group.map((op) => opItem(op, { action: false })), "\n</details>");
  }
  doc.always("", "</details>");
}

function reportOnlySections(doc: Doc, ops: PlanOp[]) {
  firewallSection(doc, ops);
  collapsed(
    doc,
    "Frozen droplets: changes shown, never applied",
    ops.filter(isFrozenReport).map((op) => opItem(op, { action: false })),
  );
  collapsed(doc, "Other report-only items, never applied", ops.filter(isOtherReport).map((op) => opItem(op, { action: false })));
}

function unmanagedSection(doc: Doc, r: RunReport, intro: string) {
  collapsed(
    doc,
    "Droplets with no file, left alone",
    r.unmanaged.map((d) => `- ${code(d.name)} (${mdText(d.region)}, id ${d.id})`),
    intro,
  );
}

const commitNote = (r: RunReport): string => (r.infraCommit ? ` (infra commit ${code(r.infraCommit.slice(0, 12))})` : "");

// ---------- check: the PR comment ----------

/** The PR comment for `check`: "what happens when this is merged", counts first, then detail grouped by droplet. */
export function renderPrComment(r: RunReport): string {
  const c = reportCounts(r);
  const ops = allOps(r);
  const changes = ops.filter(isChange);
  const unchanged = r.plans.reduce((n, p) => n + p.unchanged, 0);
  const passed = reportPassed(r);
  const doc = new Doc(PR_COMMENT_MAX);

  let verdict: string;
  if (!passed) {
    verdict =
      "❌ **Checks failed. Don't merge this yet:** fix the errors below first. GitHub won't stop the merge, but the apply after it runs the same checks and writes nothing while any of them fails, so later merges stay stuck until this is fixed.";
  } else if (changes.length) {
    verdict = `✅ **Checks passed.** Merging this applies the ${changes.length} change(s) below to the live accounts.`;
  } else {
    verdict = "✅ **Checks passed.** Merging this changes nothing in the live accounts: they already match the droplet files.";
  }
  if (c.report) verdict += ` ${c.report} report-only item(s) are listed too; they are never applied.`;

  doc.always(
    PR_COMMENT_MARKER,
    "## What happens when this is merged",
    "",
    verdict,
    "",
    `Planned against the live accounts when this check ran${commitNote(r)}. Merge one pull request at a time: after a merge, update the next one's base so its plan is made again.`,
    "",
    ...countsTable(ops, unchanged),
    "",
    `Droplet files: ${c.dropletFiles} · Errors: ${c.errors} · Warnings: ${c.warnings} · Droplets with no file: ${c.unmanaged}`,
  );
  errorsSection(doc, r);
  warningsSections(doc, r);
  opsByDroplet(doc, "Changes the apply will make", changes, { provider: true });
  reportOnlySections(doc, ops);
  unmanagedSection(doc, r, "Droplets in DigitalOcean that have no droplet file. The tool never touches them; add a file to manage one.");
  return doc.text();
}

// ---------- apply ----------

/** The detail file after `apply`: what was done, what failed, what was skipped (frozen, report-only). */
export function renderApplySummary(r: RunReport): string {
  const c = reportCounts(r);
  const ops = allOps(r);
  const stop = applyStopped(r);
  const applied = r.applied.flatMap((a) => a.applied);
  const failed = r.applied.flatMap((a) => a.failed);
  const skipped = r.applied.flatMap((a) => a.skipped).filter((s) => s.op.action !== "report");
  const doc = new Doc();

  let status: string;
  if (stop?.partial) status = "❌ stopped part-way";
  else if (stop) status = "⛔ blocked: nothing was applied";
  else if (!reportPassed(r)) status = applied.length ? "❌ partly applied, with failures" : "❌ failed";
  else if (applied.length) status = "✅ applied";
  else status = "ℹ️ nothing to change";

  doc.always(
    `## infra apply: ${status}`,
    "",
    `Applied ${applied.length} · failed ${failed.length} · skipped ${skipped.length} · report only ${c.report}${commitNote(r)}.`,
  );
  if (stop) doc.always("", `**${stop.partial ? "Stopped part-way" : "Nothing was applied"}:** ${mdText(stop.reason)}.`);

  const failedItems = failed.map((f) => `- **${f.op.action}** ${PROVIDER_LABEL[f.op.provider]} ${f.op.kind} ${code(f.op.key)}${f.op.droplet ? ` (${code(f.op.droplet)})` : ""}: ${mdText(clip(f.error, MESSAGE_MAX))}`);
  errorsSection(doc, r, failedItems);
  warningsSections(doc, r);
  opsByDroplet(doc, "Applied", applied, { provider: true });
  if (stop) opsByDroplet(doc, "Planned, not applied", stop.notApplied, { provider: true });
  for (const [reason, group] of groupBy(skipped, (s) => s.reason)) {
    collapsed(doc, `Skipped: ${mdText(reason)}`, group.map((s) => opItem(s.op, { provider: true })));
  }
  reportOnlySections(doc, ops);
  unmanagedSection(doc, r, "Droplets with no droplet file. Left alone.");
  return doc.text();
}

// ---------- drift ----------

/** The daily drift report: droplets with no file, hand-made changes (the plan's ops), credential expiry. */
export function renderDriftReport(r: RunReport): string {
  const c = reportCounts(r);
  const ops = allOps(r);
  const changes = ops.filter(isChange);
  const creds = credentialChecks(r);
  const credProblems = creds.filter((x) => x.level === "error" || x.level === "warning");
  const doc = new Doc();

  let status: string;
  if (!reportPassed(r)) status = "❌ errors";
  else if (changes.length || r.unmanaged.length || credProblems.length) status = "⚠️ drift found";
  else status = "✅ no drift";

  doc.always(
    `## Daily drift report: ${status}`,
    "",
    `${reportTime(r).toISOString().slice(0, 10)}${commitNote(r)}. This report changes nothing.`,
    "",
    `Hand-made changes: ${changes.length} · Droplets with no file: ${c.unmanaged} · Report-only differences: ${c.report} · Errors: ${c.errors} · Warnings: ${c.warnings}`,
  );

  if (creds.length) {
    const icon = { error: "❌", warning: "⚠️", ok: "✅", unknown: "❔" } as const;
    doc.always(
      "",
      "### Credentials",
      "",
      ...creds.map((x) => {
        const advice =
          x.level === "error"
            ? " Renew it now: every run fails without it."
            : x.level === "warning"
              ? ` Renew it before then (warning starts ${EXPIRY_WARN_DAYS} days ahead).`
              : "";
        return `- ${icon[x.level]} ${code(x.name)} ${x.text}.${advice}`;
      }),
    );
  }
  errorsSection(doc, r);
  if (r.unmanaged.length) {
    doc.always("", `### Droplets with no file (${r.unmanaged.length})`, "", "They are left alone. Add a droplet file to manage one, or delete it by hand if it isn't needed.", "");
    doc.section("", r.unmanaged.map((d) => `- ${code(d.name)} (${mdText(d.region)}, id ${d.id})`));
  }
  opsByDroplet(doc, "Hand-made changes", changes, {
    provider: true,
    intro:
      "The live accounts differ from the droplet files on `main`. Each line is what the next apply (any merge into `main`) would do to put it back, unless a droplet file is changed to match first.",
  });
  warningsSections(doc, r);
  reportOnlySections(doc, ops);
  return doc.text();
}
