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
- **Fields:** a `Website` monitor named `<hostname><path>`, every minute (`* * * * *`), one step: `GET https://<hostname><path>` without following redirects (as the Worker's `redirect: "manual"`). Its description is `managed-by:infra-sync <key> (droplets/<file>; edits made here are overwritten)`.
- **Ownership and identity:** the description's first word is the marker, and its second word is the key. A monitor whose description is only the marker is identified by its name.
- **Criteria,** judged in order, where the first match decides:
  1. *(only with `acceptApp404`)* `infra-sync: app 404 counts as up`. All of: online, status 404, and the body does not contain `error code: 1`. That body filter matches nothing on an empty body, so the tunnel's empty 404 still fails.
  2. `infra-sync: offline`. Any of: not online, status ≥ 400, status < 200. It sets the project's offline status and opens an auto-resolving incident at the most severe incident severity, paging `on_call_policy_ids`.
  3. `infra-sync: online`. All of: online, status 200–399. It sets the operational status.
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
