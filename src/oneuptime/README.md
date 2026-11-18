# oneuptime (B5): uptime monitors in OneUptime

OneUptime handles ongoing health (decision 3). The tool creates each site's monitors in OneUptime from the droplet files, and OneUptime alerts the existing Telegram chat. Kuma is not used, because it has no supported API for creating monitors.

## What it must do

- **`observeMonitors(ctx)`:** list the project's monitors (`account.oneuptime.url`, `project_id`).
  - **Access:** OneUptime sits behind the staff login, so every request carries the Access service-token headers (`CF-Access-Client-Id: ONEUP_ACCESS_CLIENT_ID`, `CF-Access-Client-Secret: ONEUP_ACCESS_CLIENT_SECRET`) as well as the API key (`ONEUPTIME_API_KEY`, in the header OneUptime documents).
  - **Ownership:** a monitor is the tool's when its description starts with `managed-by:infra-sync` (`DNS_COMMENT_MARKER`). Count the others; never return or touch them.
- **`planMonitors(desired, observed)`** (pure):
  - **One HTTP monitor per entry in `DesiredDroplet.monitors`.** Defaults are already applied: with no `monitors:` key, every site hostname gets one at `web.healthPath`. Its key is `"<hostname><path>"`.
  - **What it checks:** the URL is `https://<hostname><path>`. It is healthy on 2xx/3xx. With `acceptApp404: true`, an app 404 with a non-empty body is healthy too, but the tunnel's empty 404 still fails (see the Worker's `src/health.ts` `classifyResponse`).
  - **Alerts:** through `account.oneuptime.on_call_policy_ids`.
  - **Ops:** create, or update when an owned monitor differs. An owned monitor that no file wants any more becomes a `report` op, deleted by hand (build plan: create and update only).
  - **Staff sites:** a `web.exposure: staff` site answers 302 to the login unless the path is bypassed. Deploy targets have a `/healthcheck` bypass. Otherwise add a warning diagnostic, as the Worker's `healthWeak` flag does.
- **`applyMonitors(ctx, ops)`:** create and update through the API, never delete.

## Inputs and outputs

- **Input:** `DesiredState` (`droplets[].monitors`, `droplets[].web`, `account.oneuptime`).
- **Observed:** `OneUptimeObserved`.
- **Output:** a `ModulePlan` and an `ApplyResult`.

If `account.oneuptime` is missing, return an empty plan with an info diagnostic.

## Port from

From the infra-sync Worker, take the probe rules and target list from `src/health.ts` (`classifyResponse`, `healthTargets`), but not the probing itself: OneUptime probes now. Tests go in `test/oneuptime/` and use fake data only.
