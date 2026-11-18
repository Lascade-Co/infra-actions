# oneuptime (B5): uptime monitors in OneUptime

OneUptime handles ongoing health (decision 3). The tool creates each site's monitors in OneUptime from the droplet files, and OneUptime alerts the existing Telegram chat. Kuma is not used, because it has no supported API for creating monitors.

## What it must do

- **`observeMonitors(ctx)`:** list the project's monitors (`account.oneuptime.url`, `project_id`).
  - **Access:** OneUptime sits behind the staff login, so every request carries the Access service-token headers (`CF-Access-Client-Id: ONEUP_ACCESS_CLIENT_ID`, `CF-Access-Client-Secret: ONEUP_ACCESS_CLIENT_SECRET`) as well as the API key (`ONEUPTIME_API_KEY`, in the header OneUptime documents).
  - **Read-only runs:** if OneUptime's list or query endpoints are POST, call them with `ApiClient.request(..., { read: true })`. Never do that for an endpoint that changes anything.
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

## How it is built

`api.ts` holds everything specific to OneUptime's API: endpoints, headers, the `monitorSteps` wire format and how a monitor is read back. It was written from OneUptime 16.0.0's source and API reference without calling any instance, so if the first live read-only run disagrees, fix that one file. `index.ts` decides what to do.

**Requests** (base `account.oneuptime.url` + `/api`). Every request carries `CF-Access-Client-Id`, `CF-Access-Client-Secret`, `ApiKey` and `ProjectID: <project_id>`.

| What | Request |
| --- | --- |
| List monitors (read) | `POST /api/monitor/get-list?skip=N&limit=100` with body `{ query: {}, select: {...}, sort: { createdAt: "ASC" } }` |
| Monitor statuses (read) | `POST /api/monitor-status/get-list` (the same paging) |
| Incident severities (read) | `POST /api/incident-severity/get-list` |
| On-call policies (read, only when `on_call_policy_ids` is set; a refusal becomes a warning) | `POST /api/on-call-duty-policy/get-list` |
| Create | `POST /api/monitor` with body `{ data }` |
| Update | `PUT /api/monitor/<id>` with body `{ data }`, never with `monitorType` (OneUptime can't change it) |

**A monitor.**
- **Fields:** a `Website` monitor named `<hostname><path>`, every minute (`* * * * *`), one step: `GET https://<hostname><path>` without following redirects (as the Worker's `redirect: "manual"`), a 10 s request timeout (`requestTimeoutInMs`) and 2 retries within the check (`retryCount`, as the Worker's re-probe of a failed check). Its description is `managed-by:infra-sync <key> (droplets/<file>; edits made here are overwritten)`.
- **Ownership and identity:** the description's first word is the marker (so a description starting `managed-by:infra-sync2` is not the tool's), and its second word is the key, so a monitor renamed by hand keeps its identity. When that word isn't shaped like `<hostname><path>`, or the description is only the marker, the monitor's name is the key.
- **Criteria,** judged in order, where the first match decides:
  1. *(only with `acceptApp404`)* `infra-sync: app 404 counts as up`. All of: online, status 404, and the body does not contain `error code: 1`. That body filter matches nothing on an empty body, so the tunnel's empty 404 still fails.
  2. `infra-sync: online`. All of: online, status 200–399. It sets the operational status.
  3. `infra-sync: offline`. Any of: not online, status ≥ 400, status < 200, **each judged over the last 3 minutes** (`evaluateOverTime`, `All Values`, 3 minutes). It sets the project's offline status and opens an auto-resolving incident at the most severe incident severity, paging `on_call_policy_ids`.

  The healthy criteria come first on purpose. A windowed filter is judged from the stored samples only, and the source doesn't make clear whether the current check is already stored when the criteria run. With healthy first, a check that is healthy now always matches it and is never marked down, either way.
- **Paging noise (owner, 2026-11-19).** A site is marked offline, and paged, only after **3 failing minutes in a row**, as the Worker's `FAILS_TO_ALERT`. OneUptime's per-step `retryCount` only retries inside one check, so the 3 minutes come from "evaluate over time" on each offline filter: `All Values` fires only when every check of the window matched and the checks cover the whole window, so a new monitor or one bad minute never pages. Recovery (`online`, `app 404`) is judged on the latest check and comes first, so it is immediate. In the minutes before the window fills, no criteria matches and the monitor takes the default (operational) status.
- **Timeouts.** The Worker counted a timeout, a network error or a 429 as inconclusive (neither a failure nor a reset). OneUptime has no such outcome, so as close as it allows:
  - each check retries twice (10 s each) before it counts, so one slow answer is not a failed minute;
  - a check with no answer records no status code, so the status-code windows skip it, as the Worker did;
  - but it is "not online", so 3 minutes of nothing but timeouts do page (the Worker never paged on timeouts alone);
  - a 429 is an error answer and counts toward the status ≥ 400 window.

  There is deliberately no "inconclusive" criteria that matches timeouts without changing the status: a check that matches another criteria, or none, resolves an open auto-resolving incident (`MonitorIncident.shouldCloseIncident`), so it would resolve and reopen the incident mid-outage, which is more noise, not less. For the same reason, an outage that alternates between error answers and timeouts can drop out of the window for a minute.

  All of this is read from OneUptime's source (`main`, version 16.0.0, 2026-11-19: `CriteriaFilter.ts`, `EvaluateOverTime.ts`, `APIRequestCriteria.ts`, `MonitorMetricUtil.ts`, which writes a status-code sample only when the check got a status code, `MonitorIncident.ts`, `MonitorStep.ts`), not from a live instance.

**First live run: confirm these.**
- `requestTimeoutInMs`, `retryCount`, `evaluateOverTime` and `evaluateOverTimeOptions` come back from the list endpoint as written. If the server drops or renames one, every plan shows an update to every monitor forever; fix the field names in `api.ts`.
- A test outage pages once, after 3 minutes, and recovers once.
- **Project ids:** the operational status, the offline status and the severity are read from the project (lowest priority, lowest order). A project missing one is an error diagnostic.
- **Plan and ids:** the plan compares a normalised view of each monitor (`MonitorView`: URL, interval, redirects, criteria as text, on-call ids, status and severity names), never raw JSON. An update carries the existing step, criteria and incident ids so OneUptime keeps their history.

**Ops.**
- `create` and `update` on owned monitors only.
- `report` for an owned monitor that no file wants, an owned duplicate of a key, or an owned monitor whose type isn't `Website`.
- No deletes.
- Apply stops at the first failure and skips the ops after it.

**Diagnostics.**
- warning `monitor-health-weak`: a staff site's path isn't bypassed, or a public site's path is under a protected path (the Worker's `healthWeak`).
- error `duplicate-monitor`, `oneuptime-project` and `oneuptime-on-call-policy` (an id that isn't in the project).
- warning `oneuptime-on-call-policy` when the policies couldn't be read.
- info `oneuptime-not-configured`.
