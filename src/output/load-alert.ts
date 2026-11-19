// Telegram alert when an apply or a drift run can't load the infra data.
//
// Without it, a broken checkout on main (bad YAML, a file failing the schema, account.yaml
// missing) would stop every apply and every drift report with nothing but a red run in the
// public Actions log. The message is short and holds no names: the run kind, the short commit,
// and the count of errors per diagnostic code (fixed machine codes such as "schema" or
// "layout"). The detail stays where it always is: the --out file and the PR check.
//
// The chat id normally comes from account.yaml, which may be the file that failed. So it is
// read leniently: any account.yaml that parses as YAML and has telegram.chat_id in the
// schema's format will do, whatever else is wrong with it. Failing that, TELEGRAM_CHAT_ID from
// the environment. With neither, the alert is skipped (and the run still fails).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import type { Diagnostic } from "../core/diagnostics.js";
import type { FetchFn } from "../core/http.js";
import { ACCOUNT_FILE } from "../core/loader.js";
import type { Secrets } from "../core/secrets.js";
import { esc } from "./telegram.js";

const CHAT_ID_RE = /^-?[0-9]+$/;

/** telegram.chat_id from account.yaml even when that file fails the schema; else TELEGRAM_CHAT_ID. */
export async function lenientChatId(infraDir: string, env: Record<string, string | undefined>): Promise<string | undefined> {
  try {
    const data = parse(await readFile(join(infraDir, ACCOUNT_FILE), "utf8")) as { telegram?: { chat_id?: unknown } } | null;
    const raw = data?.telegram?.chat_id;
    const id = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
    if (typeof id === "string" && CHAT_ID_RE.test(id)) return id;
  } catch {
    // missing, unreadable or not YAML: fall through to the environment
  }
  const fromEnv = env.TELEGRAM_CHAT_ID?.trim();
  return fromEnv && CHAT_ID_RE.test(fromEnv) ? fromEnv : undefined;
}

/**
 * One message, no names: "infra apply: the infra data at abc1234 did not load. 3 errors
 * (schema 2, layout 1). Nothing was applied."
 */
export function renderLoadFailure(run: "apply" | "drift", diagnostics: readonly Diagnostic[], commit?: string, internalError = false): string {
  const errors = diagnostics.filter((d) => d.level === "error");
  const byCode = new Map<string, number>();
  for (const d of errors) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
  const kinds = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => `${esc(code)} ${n}`)
    .join(", ");
  const at = commit ? ` at <code>${esc(commit.slice(0, 7))}</code>` : "";
  const what = internalError
    ? "the loader stopped with an internal error"
    : `${errors.length} ${errors.length === 1 ? "error" : "errors"}${kinds ? ` (${kinds})` : ""}`;
  const outcome = run === "apply" ? "Nothing was applied." : "No drift report today.";
  return `❌ <b>infra ${run}</b>: the infra data${at} did not load: ${what}. ${outcome} Open a pull request against main to see the details in its check.`;
}

/**
 * Sends the alert. Throws a fixed message on failure (the token is in the URL, so no fetch error
 * text is ever passed on). Returns false when it was skipped (no token or no chat id).
 */
export async function sendLoadFailure(opts: {
  fetch: FetchFn;
  secrets: Secrets;
  chatId: string | undefined;
  text: string;
}): Promise<boolean> {
  if (!opts.chatId || !opts.secrets.has("TELEGRAM_BOT_TOKEN")) return false;
  const token = opts.secrets.require("TELEGRAM_BOT_TOKEN");
  let res: Response;
  try {
    res = await opts.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: opts.chatId, text: opts.text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch {
    throw new Error("telegram sendMessage failed: network error (load alert)");
  }
  if (!res.ok) throw new Error(`telegram sendMessage failed with HTTP ${res.status} (load alert)`);
  return true;
}
