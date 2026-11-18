# cloudflare (B1): Cloudflare reconcile

Port the infra-sync Worker's reconcile logic to this tool. The input changes from DigitalOcean tags plus `web-config.json` to the desired state built from droplet files. The ownership marker stays the same (`managed-by:infra-sync`, `infra-sync:` name prefixes; see `src/core/constants.ts`), so the tool adopts everything the Worker created and nothing needs importing.

## What it must do

- **`observeCloudflare(ctx)`** (read-only). Read the account's zones, infrastructure targets and Access apps. Read the configuration of every tunnel in `account.cloudflare.tunnels` and every DNS record of every zone. Return `CloudflareObserved` (`types.ts`). A failed tunnel or zone read becomes `{ error }`, never an exception, so the plan can fail closed. Build the client from `ApiClient` (`src/core/http.ts`) with `CF_API_TOKEN` and `ctx.allowWrites`.
- **`planCloudflare(desired, observed)`** (pure). Do what the Worker's `buildPlan` + `planWeb` do, emitting `PlanOp`s:
  - **for each droplet with an SSH route:** an infra target, an ssh- Access app, a tunnel ingress rule, the ssh- CNAME and the vpc- A record;
  - **account-wide:** the infrastructure app;
  - **for deploy targets:** healthcheck bypass apps;
  - **for sites:** site, admin and exception apps, the route (with 404 rules for protected paths on extra hostnames), the site CNAME, and dependents/implicit hostnames (guard rail 1);
  - **deletes:** stale objects, in the Worker's fail-closed rules.
  - **New:**
    - `allow.tunnel` routes plus an Access app for `who` (`staff` → the reusable staff policy; `service-token:<name>` → a Service Auth policy with `account.cloudflare.service_tokens[name]`);
    - exception `allow.service_tokens` → a Service Auth policy next to the ips Bypass.
  - **Which droplets to plan:**
    - A droplet with `status: "create"` gets ops with `pending: true` and `KNOWN_AFTER_CREATE` in place of IPs.
    - Droplets with `status: "missing" | "conflict"`, or with a `namingError`, are held: never deleted, never managed (like the Worker's `heldNames`).
  - **Diagnostics:** the Worker's `skipped`/`conflicts`/`warnings`/`errors` become diagnostics. Mind the severity: **any error-level diagnostic blocks the whole apply**, so map them like this:
    - Worker `errors` (a read failed, a dependent that will break) → `error`;
    - `conflicts` (a name held by a record or app the tool doesn't own) and `skipped` (a region with no tunnel, no private IP yet) → `warning`. The Worker managed everything else and held these back, and the tool does the same;
    - Worker `warnings` → `warning`.
  - **Zones:** names are matched against `account.cloudflare.zones`, but the Worker matched against every zone in the account. Longest-suffix matching means an extra or missing zone changes labels. Emit an `error` when the observed account zones and `account.cloudflare.zones` differ.
  - **Guard rail:** if deletes exceed `account.cloudflare.guards` or a read failed, turn the deletes into `report` ops with the reason.
- **`applyCloudflare(ctx, ops, observed)`.** Use the Worker's order (`sync.ts`):
  - creates: target → app → ingress → DNS;
  - deletes: DNS → ingress → app → target, stopping a hostname's chain at its first failure;
  - each tunnel configuration: read, modify and write as one document.
- **Not ported:** cutover, rollback and the minute health watch (they stay in the Worker until Phase F), and the KV/Telegram code (B7).

Op keys and kinds: see `ResourceKind` in `src/core/plan.ts`. Always set `droplet` on per-droplet ops, so that frozen droplets work.

## Port from (in `../infra-sync/` of the audit folder, not in this repo)

`src/plan.ts`, `src/ingress.ts`, `src/dependents.ts`, `src/sync.ts`, `src/clients/cloudflare.ts`, `src/config.ts` (its constants are already in `src/core/constants.ts`: markers, app name prefixes, `INFRA_APP_NAME`, `SSH_USERNAMES`, `HEALTH_BYPASS_PATH`, `VPC_TTL`, `MAX_CNAME_CHAIN` and the web defaults; the admin emails come from `account.cloudflare.ssh_admin_emails`, never from code), and the tests `test/sync.test.ts`, `test/ingress.test.ts`, `test/guardrails.test.ts`, `test/fake.ts`. **Port tests with fake data only** (`example.com`, RFC 5737 IPs, placeholder UUIDs): the Worker's tests and `web-config.json` carry real names and must not be copied into this public repo.

## Mapping: Worker input → droplet file → desired state

| Worker input | Droplet file | `DesiredDroplet` |
|---|---|---|
| droplet name | `name` (= file name) | `name`, `zone`, `label`, `sshHostname`, `vpcHostname` |
| region → `TUNNELS_BY_REGION` | (observed) | `region`, `tunnelId` (from `account.cloudflare.tunnels`) |
| `networks.v4[type=private]` | (observed) | `privateIpv4` |
| tag `env-prod` / `env-staging` / `env-internal` | `env` | `env` |
| tag `ci-deploy` | `deploy: true` | `deploy` |
| `CI_SERVICE_TOKEN_IDS[env]` | `account.cloudflare.ci_deploy_tokens[env]` (names) | ids via `account.cloudflare.service_tokens` |
| tag `web-staff` / `web-public` | `web.exposure: staff / public` | `web.exposure`, `web.tag` |
| `web-config.json` `origin` | `web.origin` | `web.origin` (default `https://{ip}:443` applied) |
| `hostnames` | `web.hostnames` | `web.extraHostnames`; `web.hostnames` = name + extras |
| `protected_paths` | `web.protected_paths` (public only) | `web.protectedPaths` (default `["/admin"]` for public, `[]` for staff) |
| `exceptions[{path, allow: "everyone" \| {ips}}]` | `web.exceptions[{path, allow}]` (+ `service_tokens`) | `web.exceptions` (CIDRs normalised: `/32`, sorted, deduplicated) |
| `health_path` | `web.health_path` | `web.healthPath` (default `/healthcheck/` with deploy, else `/`) |
| `health_accept_app_404` | `web.health_accept_app_404` | `web.healthAcceptApp404` |
| `SSH_ADMIN_EMAILS` | `account.cloudflare.ssh_admin_emails` | `desired.account…` |
| `STAFF_POLICY_ID`, `TEAM_DOMAIN`, `CF_ACCOUNT_ID` | `account.cloudflare.staff_policy_id`, `team_domain`, `account_id` | same |
| `MAX_DELETES`, `MAX_DELETE_FRACTION` | `account.cloudflare.guards` | same |
| `ALLOW_MASS_DELETE`, `DRY_RUN` | none: check is the dry run; apply is the merge | n/a |

### Worker states the droplet file can't express (for the phase D export)

- **A droplet with both `web-staff` and `web-public`.** The Worker builds no site for it. The export must flag it; there's no file equivalent.
- **A `web-config.json` entry for a droplet with no web tag.** It's inert in the Worker. The export drops it (zero Cloudflare change) and lists it.
- **`protected_paths` on a `web-staff` site.** It's inert in the Worker, and the schema rejects it. The export drops it and lists it.
- **Several `env-*` tags.** The Worker warns and treats the droplet as having no env. A file has at most one env, so the export flags it.
- **A droplet with no `env-*` tag.** Allowed: leave out `env` (without `deploy` or a `profile`).
