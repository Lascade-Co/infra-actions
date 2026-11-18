# output (B7): what people read

Every run produces two outputs:

- **one log line**, which goes to stdout and so to this public repo's Actions logs;
- **a detail file**, written to the CLI's `--out` path. The workflow posts it as the PR comment on the private `infra` repo or keeps it out of the logs.

Telegram gets a summary after every apply (also when it was blocked or failed, since an apply has no PR to comment on) and after every drift run. The engine already calls `renderTelegram` and `sendTelegram` at those points.

## Already written in B0 (keep the rules)

- **`renderLogLine(report)`:** counts and PASS/FAIL **only**. It holds no names, hostnames, IPs, ids, file paths or error text. `test/cli.test.ts` enforces this against every fixture value.
- **`renderBasicDetail(report)`:** a plain dump of the stages, diagnostics, ops and unmanaged droplets. It's the fallback.
- **`renderDetail(report)`:** dispatches by mode to the B7 renderers below. It falls back to the basic dump while they throw `NotImplementedError`.

## What B7 must do

- **`renderPrComment(report)`** (check). A GitHub markdown comment whose first line is `PR_COMMENT_MARKER` (`<!-- infra-actions:plan -->`, so the workflow finds and updates its own comment), then the heading "What happens when this is merged". It holds:
  - pass/fail, what merging does, and a create/update/delete/report-only count table per provider first;
  - errors with `file:line path` (diagnostics carry them);
  - then the ops grouped by droplet, with the global ones (infra app, ssh config) under their own heading. For each op, show its action, kind, key and reason, and a compact `before → after` (use `<details>` for long ones);
  - a separate section for report-only ops: firewall rules (state "not enforced until Phase 5") and frozen droplets. The firewall report is large (broad firewalls attached by tag show on every droplet), so it is one collapsed block holding one collapsed block per droplet, whose summary gives its counts ("3 to allow, 2 to remove");
  - the Cloudflare warnings people act on, each under its own heading and never cut for size: awaiting cutover (`cloudflare-awaiting-cutover`), held or skipped droplets and names (`cloudflare-skipped`, `cloudflare-conflict`) and tunnel routes the tool doesn't build (`cloudflare-route-not-built`). Other warnings follow;
  - the `KNOWN_AFTER_CREATE` values, which show as "known after create";
  - unmanaged droplets;
  - stages that failed or aren't implemented.

  Keep it under GitHub's 65,536-character limit: truncate the detail with a note, never the counts or the errors.
- **`renderApplySummary(report)`** (apply): what was applied, what failed (with the error), and what was skipped and why. Use the same grouping.
- **`renderDriftReport(report)`** (drift, daily):
  - droplets with no file;
  - hand-made changes, which are the plan's ops (each one is a difference between the files and the live accounts);
  - credential expiry from `report.credentials`, warning when the GitHub token expires within 30 days (`EXPIRY_WARN_DAYS`), an error once it has expired.
- **`renderTelegram(report)`:** HTML messages, each under 4096 characters. The first line is a status (❌ errors, failures or a blocked apply; ⚠️ warnings, drift or a token expiring soon; ✅ an apply that changed things or a clean drift run; ℹ️ nothing to do), then the time (from the report, never the clock) and the counts. Port the Worker's `src/format.ts`: grouping, `packMessages`, the HTML escaping and the plain-text fallback.
- **`sendTelegram(ctx, messages)`:** `POST https://api.telegram.org/bot<token>/sendMessage` to `account.telegram.chat_id`, with `TELEGRAM_BOT_TOKEN` taken from `ctx.secrets`.
  - Call `ctx.fetch` directly, not `ApiClient`: a notification isn't an infrastructure write, and drift runs are read-only.
  - The token is part of the URL, so make sure no error message ever includes the URL. It throws with a fixed message (HTTP status, part number) so the engine records a failed stage.

The renderers never show `op.ids` (provider ids, and the ssh config text that `sshconfig` carries to apply there). They live in `markdown.ts` (PR comment, apply summary, drift report), `telegram.ts` and `common.ts`; `index.ts` re-exports them.

## Inputs and outputs

- **Input:** `RunReport` (`src/core/report.ts`).
- **Output:** strings. `sendTelegram` performs the only I/O here.

## Port from

From the infra-sync Worker: `src/format.ts`, `src/telegram.ts` and `src/notify.ts` (the fingerprinting isn't needed, since apply runs only on merges), plus `src/sync.ts` `summarize` for the plain-text layout. Tests go in `test/output/` and use fake data only.
