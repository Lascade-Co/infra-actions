# output (B7): what people read

Every run produces two outputs:

- **one log line**, which goes to stdout and so to this public repo's Actions logs;
- **a detail file**, written to the CLI's `--out` path. The workflow posts it as the PR comment on the private `infra` repo or keeps it out of the logs.

Telegram gets a summary after apply and after drift.

## Already written in B0 (keep the rules)

- **`renderLogLine(report)`:** counts and PASS/FAIL **only**. It holds no names, hostnames, IPs, ids, file paths or error text. `test/cli.test.ts` enforces this against every fixture value.
- **`renderBasicDetail(report)`:** a plain dump of the stages, diagnostics, ops and unmanaged droplets. It's the fallback.
- **`renderDetail(report)`:** dispatches by mode to the B7 renderers below. It falls back to the basic dump while they throw `NotImplementedError`.

## What B7 must do

- **`renderPrComment(report)`** (check). A GitHub markdown comment with the heading "What happens when this is merged". It holds:
  - pass/fail and counts first;
  - errors with `file:line path` (diagnostics carry them);
  - then the ops grouped by droplet, with the global ones (infra app, ssh config) under their own heading. For each op, show its action, kind, key and reason, and a compact `before → after` (use `<details>` for long ones);
  - a separate section for report-only ops: firewall rules (state "not enforced until Phase 5") and frozen droplets;
  - the `KNOWN_AFTER_CREATE` values, which show as "known after create";
  - unmanaged droplets;
  - stages that failed or aren't implemented.

  Keep it under GitHub's 65,536-character limit: truncate the detail with a note, never the counts or the errors.
- **`renderApplySummary(report)`** (apply): what was applied, what failed (with the error), and what was skipped and why. Use the same grouping.
- **`renderDriftReport(report)`** (drift, daily):
  - droplets with no file;
  - hand-made changes, which are the plan's ops (each one is a difference between the files and the live accounts);
  - credential expiry from `report.credentials`, warning when the GitHub token expires within 14 days.
- **`renderTelegram(report)`:** HTML messages, each under 4096 characters. The first line is a status (✅ ⚠️ ❌), then the counts. Port the Worker's `src/format.ts`: grouping, `packMessages`, the HTML escaping and the plain-text fallback.
- **`sendTelegram(ctx, messages)`:** `POST https://api.telegram.org/bot<token>/sendMessage` to `account.telegram.chat_id`, with `TELEGRAM_BOT_TOKEN` taken from `ctx.secrets`. The token is part of the URL, so make sure no error message ever includes the URL.

## Inputs and outputs

- **Input:** `RunReport` (`src/core/report.ts`).
- **Output:** strings. `sendTelegram` performs the only I/O here.

## Port from

From the infra-sync Worker: `src/format.ts`, `src/telegram.ts` and `src/notify.ts` (the fingerprinting isn't needed, since apply runs only on merges), plus `src/sync.ts` `summarize` for the plain-text layout. Tests go in `test/output/` and use fake data only.
