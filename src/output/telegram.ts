// Telegram summaries after apply and drift runs, ported from the infra-sync Worker's
// format.ts / telegram.ts. HTML parse mode; every block has balanced tags and is at most
// BLOCK_MAX characters, so messages are packed from whole blocks and never split a tag.

import { formatDiagnostic } from "../core/diagnostics.js";
import { isChange, type PlanOp, type RunContext } from "../core/plan.js";
import { reportCounts, reportPassed, type RunReport } from "../core/report.js";
import { allDiagnostics, allOps, applyBlocked, brokenStages, byKind, credentialChecks, groupBy, KIND_LABEL, opLabel, reportTime } from "./common.js";

export const MESSAGE_MAX = 3800; // Telegram allows 4096; leaves room for the "(1/3) " prefix
const BLOCK_MAX = 3400;
/** The team reads times in India Standard Time, as the Worker's messages did. */
const TIME_ZONE = "Asia/Kolkata";

export const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain-text fallback: drop tags, undo escaping. */
export const stripHtml = (s: string): string =>
  s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "19 Nov 2026, 05:30 IST" (no clock of its own: the time comes from the report). */
export function when(d: Date): string {
  try {
    return (
      new Intl.DateTimeFormat("en-GB", {
        timeZone: TIME_ZONE,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d) + " IST"
    );
  } catch {
    return d.toISOString();
  }
}

/** A titled list in a blockquote (collapsible when expandable), split into several blocks if long. */
export function listBlocks(title: string, items: string[], expandable: boolean): string[] {
  const blocks: string[] = [];
  const open = expandable ? "<blockquote expandable>" : "<blockquote>";
  let cur: string[] = [];
  let len = 0;
  let part = 0;
  const flush = () => {
    if (!cur.length) return;
    const head = part === 0 ? title : `${title} (continued)`;
    blocks.push(`${head}\n${open}${cur.join("\n")}</blockquote>`);
    cur = [];
    len = 0;
    part++;
  };
  for (const raw of items) {
    const line = raw.length > 500 ? raw.slice(0, 499) + "…" : raw;
    if (len + line.length + 1 > BLOCK_MAX - title.length - 60) flush();
    cur.push(line);
    len += line.length + 1;
  }
  flush();
  return blocks;
}

/** Packs whole blocks into messages of at most `max` characters. */
export function packMessages(blocks: string[], max = MESSAGE_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + 2 + b.length > max) {
      out.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const item = (op: PlanOp): string => {
  const label = opLabel(op);
  return `${esc(label)}${op.droplet && !label.includes(op.droplet) ? ` <i>(${esc(op.droplet)})</i>` : ""}`;
};

/** One block list per kind of object, collapsed. */
function kindBlocks(emoji: string, verb: string, ops: PlanOp[], line: (op: PlanOp) => string = item): string[] {
  return byKind(ops).flatMap(([kind, group]) =>
    listBlocks(`${emoji} <b>${verb}</b>: ${esc(KIND_LABEL[kind])} (${group.length})`, group.map(line), true),
  );
}

/** The report as HTML blocks, in reading order: status and counts, problems, then detail. */
export function telegramBlocks(r: RunReport): string[] {
  const c = reportCounts(r);
  const ops = allOps(r);
  const blocked = applyBlocked(r);
  const creds = credentialChecks(r).filter((x) => x.level === "error" || x.level === "warning");
  const applied = r.applied.flatMap((a) => a.applied);
  const failed = r.applied.flatMap((a) => a.failed);
  const skipped = r.applied.flatMap((a) => a.skipped).filter((s) => s.op.action !== "report");
  const changes = ops.filter(isChange);
  const drift = r.mode === "drift";

  const hasErrors = !reportPassed(r) || !!blocked || creds.some((x) => x.level === "error");
  const hasWarn = c.warnings > 0 || creds.length > 0 || (drift && (changes.length > 0 || c.unmanaged > 0));
  const status = hasErrors ? "❌" : hasWarn ? "⚠️" : (r.mode === "apply" && applied.length) || drift ? "✅" : "ℹ️";

  const title = drift ? "infra drift report" : `infra ${r.mode}`;
  const head = [`${status} <b>${title}</b>${r.infraCommit ? ` · <code>${esc(r.infraCommit.slice(0, 7))}</code>` : ""}`];
  if (blocked) head.push(`🛑 <b>Nothing applied</b>: ${esc(blocked)}`);
  head.push(`🕒 ${when(reportTime(r))}`);

  const counts: string[] = [];
  if (c.errors) counts.push(`❌ ${plural(c.errors, "error")}`);
  if (c.warnings) counts.push(`⚠️ ${plural(c.warnings, "warning")}`);
  if (drift) {
    if (changes.length) counts.push(`✏️ ${plural(changes.length, "hand-made change")}`);
    if (c.unmanaged) counts.push(`📦 ${plural(c.unmanaged, "droplet")} with no file`);
  } else {
    const done = { create: 0, update: 0, delete: 0 };
    for (const op of applied) if (op.action !== "report") done[op.action]++;
    if (done.create) counts.push(`➕ ${done.create} created`);
    if (done.update) counts.push(`✏️ ${done.update} updated`);
    if (done.delete) counts.push(`🗑 ${done.delete} deleted`);
    if (failed.length) counts.push(`💥 ${failed.length} failed`);
    if (skipped.length) counts.push(`⏭ ${skipped.length} skipped`);
    if (blocked && changes.length) counts.push(`⏸ ${changes.length} not applied`);
  }
  if (c.report) counts.push(`📋 ${c.report} report-only`);
  const nothing = drift ? "No drift: the live accounts match the droplet files." : "No changes, nothing to report.";
  head.push("", counts.length ? counts.join("   ") : nothing);

  const blocks = [head.join("\n")];

  // Problems first, never collapsed.
  const errors = [
    ...failed.map((f) => `• <b>${esc(f.op.kind)}</b> ${esc(opLabel(f.op))}: ${esc(f.error)}`),
    ...allDiagnostics(r)
      .filter((d) => d.level === "error")
      .map((d) => `• ${esc(formatDiagnostic(d))}`),
    ...brokenStages(r).map((s) => `• stage ${esc(s.stage)} ${s.status}${s.error ? `: ${esc(s.error)}` : ""}`),
    ...creds.filter((x) => x.level === "error").map((x) => `• 🔑 ${esc(x.name)} ${esc(x.text)}`),
  ];
  if (errors.length) blocks.push(...listBlocks(`❌ <b>Errors</b> (${errors.length})`, errors, false));
  const warnings = [
    ...creds.filter((x) => x.level === "warning").map((x) => `• 🔑 ${esc(x.name)} ${esc(x.text)}: renew it`),
    ...allDiagnostics(r)
      .filter((d) => d.level === "warning")
      .map((d) => `• ${esc(formatDiagnostic(d))}`),
  ];
  if (warnings.length) blocks.push(...listBlocks(`⚠️ <b>Warnings</b> (${warnings.length})`, warnings, false));

  if (drift) {
    if (changes.length) {
      blocks.push(...listBlocks(`✏️ <b>Hand-made changes</b> (${changes.length})`, changes.map((op) => `• ${esc(op.action)} ${esc(op.kind)} ${item(op)}`), true));
    }
    if (r.unmanaged.length) {
      blocks.push(...listBlocks(`📦 <b>Droplets with no file</b> (${r.unmanaged.length})`, r.unmanaged.map((d) => `• ${esc(d.name)} (${esc(d.region)})`), true));
    }
    return blocks;
  }

  const verbs: Array<[PlanOp["action"], string, string]> = [
    ["create", "➕", "Created"],
    ["update", "✏️", "Updated"],
    ["delete", "🗑", "Deleted"],
  ];
  for (const [action, emoji, verb] of verbs) blocks.push(...kindBlocks(emoji, verb, applied.filter((op) => op.action === action)));
  if (blocked) blocks.push(...kindBlocks("⏸", "Not applied", changes, (op) => `• ${esc(op.action)} ${item(op)}`));
  if (skipped.length) {
    const items = [...groupBy(skipped, (s) => s.reason)].map(([reason, xs]) => `• <i>${esc(reason)}</i> (${xs.length}): ${xs.map((s) => item(s.op)).join(", ")}`);
    blocks.push(...listBlocks(`⏭ <b>Skipped</b> (${skipped.length})`, items, true));
  }
  return blocks;
}

/** Telegram messages (HTML, each under 4096 chars) summarising an apply or a drift run. */
export function renderTelegram(r: RunReport): string[] {
  return packMessages(telegramBlocks(r));
}

async function post(ctx: RunContext, token: string, payload: Record<string, unknown>): Promise<Response> {
  return ctx.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ disable_web_page_preview: true, ...payload }),
  });
}

/**
 * Sends the messages in order to account.telegram.chat_id with TELEGRAM_BOT_TOKEN, numbering
 * them when there are several. A message whose HTML Telegram rejects (400) is re-sent as plain
 * text. Throws on failure with a fixed message (HTTP status, part number): the token is in the
 * URL, so no error text from fetch is ever passed on.
 */
export async function sendTelegram(ctx: RunContext, messages: string[]): Promise<void> {
  const chatId = ctx.account.telegram?.chat_id;
  if (!chatId) throw new Error("account.yaml has no telegram.chat_id");
  const token = ctx.secrets.require("TELEGRAM_BOT_TOKEN");
  for (let i = 0; i < messages.length; i++) {
    const part = `part ${i + 1}/${messages.length}`;
    const text = messages.length > 1 ? `(${i + 1}/${messages.length}) ${messages[i]}` : messages[i]!;
    let res: Response;
    try {
      res = await post(ctx, token, { chat_id: chatId, text, parse_mode: "HTML" });
      if (res.status === 400) res = await post(ctx, token, { chat_id: chatId, text: stripHtml(text) });
    } catch {
      throw new Error(`telegram sendMessage failed: network error (${part})`);
    }
    if (!res.ok) throw new Error(`telegram sendMessage failed with HTTP ${res.status} (${part})`);
  }
}
