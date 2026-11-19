# infra-actions

`infra-actions` holds the code and workflows that keep our infrastructure in step with a private data repo. It replaces the infra-sync Cloudflare Worker: droplet files become the input in place of DigitalOcean tags and `web-config.json`.

**Status:** phase B done and the workflows are in place (B8). Every module is built and tested against fakes of the APIs, never against the live accounts. There has been no run against the real accounts yet (phase D: the plan against the live account must show zero changes before the tool takes over from the Worker).

## Two repos

| Repo | Visibility | Holds |
|---|---|---|
| `Lascade-Co/infra` | private | **Data only.** `account.yaml`, `droplets/*.yaml`, `profiles/*.yaml` with `profiles/user-data/*`, and the `ssh-config` branch. Staff propose changes by pull request from a fork. Nothing in it is ever executed. |
| `Lascade-Co/infra-actions` (this repo) | public | **All code and workflows.** `infra` dispatches its pull requests (check) and its pushes to `main` (apply) here; each run is pinned to the dispatched `infra` commit. |

Because this repo is public:

- It contains no real hostnames, IPs, account ids or droplet names.
- Examples and test fixtures use `example.com`/`example.net`, RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), `10.0.0.x` and placeholder UUIDs.
- The CLI prints one line of counts and PASS/FAIL. Everything with names goes to a file, and only to a path given on the command line (`--out`, `--json`). The workflow posts the `--out` file as a comment on the private `infra` pull request. These files are never uploaded as artifacts, cached or written to the job summary (decision 7).
- Secrets come only from environment variables (below), and are never printed or written to files.

## How it works

There's no state file. The tool reads the live accounts, compares them with the files and plans the difference. It recognises its own objects by the `managed-by:infra-sync` marker, the same one the Worker uses, so it adopts what the Worker created.

```
infra checkout ──load+validate──▶ InfraConfig ──checks──▶ diagnostics
                                       │
DigitalOcean droplets ──observe──▶ desired state (files ⨝ droplets, defaults applied)
                                       │
         each module: observe ─▶ diff ─▶ plan ops ─▶ (apply only) apply
```

## Commands

| Command | Reads | Writes | Output |
|---|---|---|---|
| `validate <dir>` | the checkout only | nothing | the log line; with `--out`, the detail |
| `check <dir> [--base <dir>]` | the checkout and every API | nothing | the PR comment (`--out`) |
| `apply <dir> [--base <dir>]` | the checkout and every API | the live accounts | the apply summary (`--out`) and Telegram |
| `drift <dir>` | the checkout and every API | nothing | the drift report (`--out`) and Telegram |
| `export <out-dir> ...` | the Worker's settings, DigitalOcean (and Cloudflare zones) | `account.yaml` and `droplets/` in `<out-dir>` | the notes (`--out`) |

- **`validate`:** load and schema only. Makes no API calls and needs no secrets. With `--notify apply` or `--notify drift` (the workflows' secret-free first pass), a checkout that doesn't load also gets the load-failure alert on Telegram, as that run would send it; that needs `TELEGRAM_BOT_TOKEN` only.
- **`check`:** read-only. Runs the checks, observes every API and plans. Its `--out` file is the PR comment, "What happens when this is merged": counts per provider, errors, warnings (awaiting cutover, held droplets and routes the tool doesn't build each have their own heading), the changes grouped by droplet, then the report-only items (the firewall report collapsed per droplet, frozen droplets). `--base` is a checkout of the PR's base: with it, the check also compares the two (a removed droplet file whose droplet still exists is an error, decision 15).
- **`apply`:** all-or-nothing (decision 16).
  1. Runs everything `check` runs. If any check, read or plan has an error, it writes nothing.
  2. Creates droplets from their profiles, each with the old firewall tag of its `env` (create-only: it never resizes, rebuilds or deletes one, and never writes a tag on an existing droplet; decision 20).
  3. Waits for the new droplets' IPs, then plans again. The new plan must be as clean as the first, or nothing else is applied.
  4. Applies Cloudflare, firewall (report-only), OneUptime and the ssh config, in that order. The first module that fails stops the run; the ones after it are skipped and the summary lists them as not applied.
  5. Sends the Telegram summary, also when apply was blocked or stopped.

  `--base` is the commit `main` was at before the push, so the decision-15 check also stops the apply. It catches a removed file only on the merge that removes it.
- **`drift`:** read-only, daily. Reports droplets with no file, hand-made changes (the plan's ops) and the GitHub token's expiry, and sends the summary to Telegram.
- **`export`** (phase D, read-only): writes the infra-sync Worker's live state as `account.yaml` plus one droplet file per droplet the Worker manages (its own rule: a lowercase name under an account zone, in a region with a tunnel). Droplets with no tags at all are left out unless `--include-untagged`. See [`src/export/run.ts`](src/export/run.ts) for the inputs:

  ```sh
  node dist/cli.js export <infra-checkout> --worker <wrangler.toml> --web-config <web-config.json> \
    [--droplets <doctl compute droplet list -o json>] [--account-base <account.yaml>] \
    [--drafts <allow/swarm drafts.yaml>] [--frozen <name,...>] [--include-untagged] --out <notes.md>
  ```

  Each file gets `env` from the `env-*` tag and `ssh: [admins]` (the group holding `SSH_ADMIN_EMAILS`), and [`src/export/convert.ts`](src/export/convert.ts) writes the rest so that the plan shows no web change:

  | The Worker's | becomes |
  |---|---|
  | `web-staff` | `web.access`: `"/": [staff]` |
  | `web-public` | `"/": [everyone]`, plus each protected path (default `/admin`) as `[staff]` |
  | exception `allow: everyone` | `"<path>": [everyone]` |
  | exception `allow: {ips, service_tokens}` | `"<path>": [ip:<cidr>, ..., token:<name>, ...]` |
  | `ci-deploy` (env `E`) | `token:<E's CI token>` in `ssh:`, and `"/healthcheck/": [everyone]` when the droplet has a site |
  | `SSH_ADMIN_EMAILS` | `account.yaml` `groups.admins` |

  Paths keep `web-config.json`'s spelling (the existing Access apps' names embed them). A `ci-deploy` droplet without a site keeps the healthcheck bypass it has (the planner holds it; it does nothing without an Access app on its host). A `web-config.json` entry on a droplet with no web tag, or both web tags, is left out and listed in the notes, and so is any draft `allow:`/`swarm:` entry the schema or the checks reject. All inputs and outputs hold real data: keep them out of this repo.
- **Load failures:** when `apply` or `drift` can't load the infra data (bad YAML, a file failing the schema, `account.yaml` missing), the run fails before any API call and posts one short Telegram message: the run, the short commit and the number of errors per code (`schema 2, layout 1`), never file or droplet names. The chat id is read leniently from `account.yaml` (any file that parses and has `telegram.chat_id`), else from `TELEGRAM_CHAT_ID` in the environment; with neither, the message is skipped.

Options for every command: `--out <file>` (the detail report, markdown), `--json <file>` (the whole report as JSON, including provider ids and the rendered ssh config) and `--commit <sha>` (the `infra` commit the run is pinned to). Nothing is written unless a path is given. `--notify <apply|drift>` is for `validate` only (above).

The exit code is 0 for pass, 1 for fail (errors, failed stages, failed apply ops) and 2 for a usage error.

## Environment variables

| Variable | Used by | For |
|---|---|---|
| `CF_API_TOKEN` | cloudflare | DNS, tunnels, Access apps, SSH targets |
| `DO_TOKEN` | droplets, firewall | droplets (create, read), tags (read, and `tag:create`: a new droplet is created with its env's firewall tag), firewalls (read) |
| `INFRA_GH_TOKEN` | sshconfig, drift | the ssh-config branch of the `infra` repo; its expiry is in the drift report |
| `ONEUPTIME_API_KEY` | oneuptime | monitors (when `account.yaml` has a `oneuptime` section) |
| `ONEUP_ACCESS_CLIENT_ID`, `ONEUP_ACCESS_CLIENT_SECRET` | oneuptime | the Cloudflare Access service token in front of OneUptime |
| `TELEGRAM_BOT_TOKEN` | apply, drift, `validate --notify` | the summary to `account.yaml` `telegram.chat_id`; skipped when either is missing |
| `TELEGRAM_CHAT_ID` | load-failure alert | optional fallback chat id when `account.yaml` is missing or unreadable; the workflows pass the repository **secret** `TELEGRAM_CHAT_ID` (a secret because GitHub prints each step's env in the public log and masks only secrets) |

`validate` needs none. `check`, `apply` and `drift` need all but `TELEGRAM_BOT_TOKEN`; a missing one fails that module's read, and the run fails.

## Modules

| Module | What it manages | Notes |
|---|---|---|
| `checks` (B2) | rules beyond the schema: names in an account zone, references between files, who-lists (groups, service tokens, email domain, web-only entries), UDP routes, swarm rules, removed files | pure; errors block check and apply |
| `droplets` (B4) | creates droplets from profiles, with the env's old firewall tag | create-only; never writes a tag on an existing droplet (decision 20) |
| `cloudflare` (B1) | SSH targets and one SSH Access app per access set, private (`vpc-`) names, sites (DNS, tunnel routes, Access apps), `allow.tunnel` routes | port of the Worker's reconcile; delete guard rails; UDP routes and port ranges are reported, not built |
| `firewall` (B3) | what `allow:` and `swarm:` imply for the DigitalOcean firewalls | report-only until migration Phase 5 |
| `oneuptime` (B5) | one HTTP monitor per site hostname (or per `monitors:` entry) | down only after 3 failing minutes; owned monitors are never deleted, only reported |
| `sshconfig` (B6) | the generated ssh config and its README on the `ssh-config` branch | the branch holds nothing else |
| `output` (B7) | the log line, PR comment, apply summary, drift report and Telegram | |

Each module's own `README.md` describes what it does, its API calls and its diagnostics.

## The droplet file

There's one file per droplet: `droplets/<droplet name>.yaml`. The name is the domain the droplet serves (a lowercase name in one of the account's zones) and must equal the file name. The schema is in [`schema/droplet.schema.json`](schema/droplet.schema.json). Editors that support `yaml-language-server` can use it with:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/Lascade-Co/infra-actions/main/schema/droplet.schema.json
```

```yaml
name: shop.example.com          # = file name; ssh-shop.example.com and vpc-shop.example.com are derived
description: Storefront
profile: ubuntu-6               # only for droplets the tool creates; adopted droplets have none
env: prod                       # prod | staging | internal: the region (and firewall tag) of a droplet the tool creates
frozen: false                   # true: plans show its changes, apply skips them (except SSH access, below)
ssh: [admins, someone@example.com, token:ci-prod]  # required who-list: who may SSH in, always as ubuntu

web:                            # the site, through the tunnel (replaces web-staff/web-public + web-config.json)
  origin: http://{ip}:80        # default https://{ip}:443 (certificate not checked)
  hostnames: [shop.example.net] # extra one-level hostnames; they get the same rules (see below)
  access:                       # path -> who-list; "/" is required
    /: [everyone]               # public site: no login on the site itself
    /admin: [staff]             # needs the staff login (404 on shop.example.net)
    /webhooks/payments: [everyone]
    /api/partner: [ip:198.51.100.0/24, token:uptime]
    /healthcheck/: [everyone]   # CI's post-deploy check, on shop.example.com only
  health_path: /healthcheck/    # default /healthcheck/ when web.access opens it to everyone, else /
  health_accept_app_404: false

monitors:                       # leave out: one HTTP monitor per site hostname; [] for none
  - hostname: shop.example.com
    path: /healthcheck/

allow:                          # who may reach this droplet (firewall: report-only until Phase 5)
  droplet:                      # other managed droplets
    - from: worker.example.com
      ports: [8080/tcp]
      note: queue worker calls the internal API
  tunnel:                       # outside callers through Cloudflare (route + Access app)
    - route: shop-db.example.com
      port: 5432/tcp
      who: [service-token:etl, staff]   # /udp only with who: [staff]
  ip:                           # fixed outside addresses that can't use Cloudflare
    - from: 192.0.2.10
      ports: [5432/tcp, 9000-9001/tcp]

swarm:                          # Docker Swarm membership; the tool derives the all-pairs rules
  cluster: jobs
  role: manager                 # manager | worker (default)
  encrypted_overlay: false      # members must agree
```

Only `name` and `ssh` are required. A minimal adopted droplet is `name: build.example.com` and `ssh: [admins]`. `env` matters only for a droplet the tool creates (its region, and the old firewall tag `production` / `staging` / `internal` it is created with). The tool writes no DigitalOcean tags otherwise (decision 20): existing tags stay as they are.

### Who-lists

`ssh:` and each `web.access` path take the same kind of list:

| Entry | Who | In `ssh:` | In `web.access` |
|---|---|---|---|
| `admins` (a group) | the emails of `account.yaml` `groups.admins` | yes | yes: one Allow policy with the people |
| `someone@example.com` | that person (must be in `account.yaml` `email_domain`) | yes | yes: in the same Allow policy |
| `staff` | anyone with a staff login | yes: every address in `email_domain` | yes: the reusable "staff" Access policy (WARP sign-in kept) |
| `everyone` | anyone, no login | **no** (error) | yes: no app on `/`, a Bypass app on any other path; must stand alone |
| `token:<name>` | a machine with that Access service token (`account.yaml` `cloudflare.service_tokens`) | yes: Service Auth on the droplet's `ssh-` route (it still logs in with its own key); never in the infrastructure app | yes: Service Auth |
| `ip:<address or CIDR>` | callers from that range | **no** (error) | yes: a Bypass for that range |

A group can't be named `staff` or `everyone`. The checks fail on an unknown group or token, an email outside `email_domain`, an empty list, `everyone` with other entries, and `everyone` or `ip:` in `ssh:`.

### Web access rules

`web.access` maps a path to who may reach it (decision 19). A path covers everything under it and the most specific path wins; `/` is required. Each path is one Access app on each hostname:

- `"/"`: `[everyone]` means no app (a public site); anything else is the whole-site app `infra-sync: web <host>`;
- a path whose list has a person (`staff`, a group, an email) is `infra-sync: web-admin <host><path>`, and it needs a login;
- a path open without one (`everyone`, `token:`, `ip:`) is `infra-sync: web-exception <host><path>`.

A list that mixes them is one app with up to four policies, in this order: Bypass for the IP ranges, Service Auth for the tokens, the reusable staff policy, one Allow policy for the groups' and emails' people. People get in on their Cloudflare One (WARP) session when the list has a person. The apps open without a login are created before the ones that keep people out, so a webhook never gets the login in between; under `"/": [everyone]`, a token or IP path keeps everyone else out and is created with them.

**Extra hostnames** (`web.hostnames`) get the same rules, with two exceptions. On a site whose `/` is `[everyone]`, a path that needs a login answers **404** in the tunnel on the extra hostnames (no Access app, so a brand domain never shows the staff login page), a list that mixes people and tokens included. And `/healthcheck/: [everyone]` (CI's post-deploy check) is the bypass app `infra-sync: healthcheck <droplet>` on the droplet's own name only. Paths open to `everyone`, `token:` or `ip:` work on every hostname.

**How Cloudflare matches paths.** [Cloudflare's documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) says only this much: an app covers the paths under its own ("If no separate, specific rule is set for `dashboard.com/eng/exec`, it will inherit any rules set for `dashboard.com/eng`"); the more specific app wins; a `*` in a path changes what it covers (`example.com/alpha/*` covers `/alpha/one` but not `/alpha`); query strings and `#` are not supported. It does not say whether `/admin` also matches `/administrator`, nor how case and a trailing slash are compared. Requests to live sites (2026-11-19, read-only) showed:

- an app on `host/admin` covers `/admin`, `/admin/` and `/admin/x`, and **not** `/administrator` or `/adminfoo` (whole path segments, as this tool assumes everywhere);
- it covers `/ADMIN` and `/Admin/x` too: Access compares paths without case. The tool compares them the same way, so `/Admin` and `/admin/` are the same path (an error if both are listed);
- a percent-encoded slash (`/admin%2Fx`) is **not** covered: it reaches the origin, which may decode it as `/admin/x`. Nothing in Access can match it; an app must not rely on Access alone for such paths.

So the loader rejects what would make a rule mean something else: `*` (a wildcard), `%` (Access doesn't decode), `//`, and two spellings of one path. The tunnel's 404 rule on extra hostnames is a regular expression on the path as written (`^/admin(/.*)?$`), and cloudflared matches it with case, so on an extra hostname `/ADMIN` would reach the origin (inferred from the regex, not observed: the probe could not tell the tunnel's 404 from the origin's). A path open without a login under a path that answers 404 there is 404 there too (a warning).

**For staff: common changes.**

```yaml
# An internal tool: only staff, with a webhook open to its sender.
web:
  access:
    /: [staff]
    /webhooks: [everyone]
```

```yaml
# Only one team, plus the uptime monitor's service token.
web:
  access:
    /: [shop-team, token:uptime]
```

```yaml
# A public site with an admin area for two people.
web:
  access:
    /: [everyone]
    /admin: [alice@example.com, bob@example.com]
```

```yaml
# CI deploys to it (production): its token in ssh, its check after a deploy.
ssh: [admins, token:ci-prod]
web:
  access:
    /: [staff]
    /healthcheck/: [everyone]
```

The check warns when `ssh:` has a token whose name starts with `ci-` and the site's `web.access` has no `/healthcheck/`.

### SSH access

`ssh:` is the droplet's SSH access list (decision 18), a who-list (above): at least one entry. People on the list log in as `ubuntu` only. Root is reached only through the DigitalOcean web console. The checks fail (and block the apply) on a missing or empty list, an unknown group or token, an empty group, an email outside `email_domain` (in a droplet file or in a group), and `everyone` or `ip:`.

In Cloudflare, the droplets that resolve to the same people (groups expanded, emails lowercased, sorted, deduplicated; `staff` as every address in `email_domain`) share one Access for Infrastructure app, `infra-sync: SSH <set id>`. Each droplet's infrastructure target carries the tag `ssh-access: <set id>`, and its app selects port 22 of the targets with that tag. The set id is the first 12 hex digits of the SHA-256 of the sorted email list (plus `@<domain>` for `staff`). The droplet's `ssh-` route app lets in the same people, and its `token:` entries (Service Auth, policy `infra-sync: ci-deploy (<env>)`, the Worker's name). Tokens never go into the infrastructure app: a service token can't get a short-lived certificate. The PR comment shows, per droplet, who gains and who loses SSH, and says once when root login goes away.

This replaces the Worker's single app (`infra-sync: SSH targets`: every admin on every droplet, as `ubuntu` or `root`). The tool owns it by its name prefix and deletes it once every target it covers carries a wanted set's tag. The apply creates the set apps first, then retags the targets (each retag waits for its set's app), then deletes the apps no set wants. A droplet that isn't managed this run (no file, held) keeps the app it relies on, with a warning.

**Frozen droplets** are the one exception to `frozen`: their SSH access is applied. Only two things change for a frozen droplet: the `ssh-access` tag on its existing infrastructure target (which set's app covers it), and the people on its existing `ssh-` app (the include list of that app's Allow policy for people; its other policies stay as they are). Everything else about a frozen droplet stays plan-only: a new IP or name on its target, its `ssh-` app's CI tokens, DNS, tunnel routes, site and healthcheck apps, monitors and firewall. Nothing is created for it either: a frozen droplet with no target yet gets none until it is unfrozen. The PR comment marks the applied ones "frozen: only SSH access changes are applied"; the rest shows as "frozen droplet, would …" (the target's and `ssh-` app's other changes as separate items, keyed `… (beyond SSH access)`). So the Worker's single app goes once every droplet, frozen ones included, carries its set's tag.

### Profiles and account config

- **`profiles/<name>.yaml`** ([schema](schema/profile.schema.json)) holds `size`, `image` (a pinned slug) and `user_data`, which names a cloud-init file in `profiles/user-data/`. The region isn't part of a profile: it follows the droplet's `env`. The VPC is always the region's default. The tool never resizes, rebuilds or deletes a droplet (create-only).
- **`account.yaml`** ([schema](schema/account.schema.json)) holds account-level values:
  - the Cloudflare account id, team domain and zones;
  - the tunnel per region;
  - the staff policy id;
  - the service tokens by name (every `token:<name>` a who-list may use, CI's included);
  - the delete guard rails;
  - the region per env;
  - the OneUptime project;
  - the `infra` repo and its ssh-config branch;
  - the Telegram chat;
  - the ssh config title;
  - `email_domain`, the only email domain allowed in who-lists (e.g. `example.com`);
  - `groups`, by name, each a non-empty list of emails in that domain (not named `staff` or `everyone`), for `ssh:` and `web.access`:

    ```
    email_domain: example.com
    groups:
      admins: [admin@example.com, ops@example.com]
      shop-team: [dev@example.com]
    ```

  It holds no secrets.

See [`examples/infra/`](examples/infra/) for a complete fake checkout.

## Workflows

| Workflow | Starts on | Does |
|---|---|---|
| `test.yml` | push, pull request | `npm ci`, typecheck, tests. No secrets. |
| `check.yml` | `repository_dispatch` `infra-check` (`pr`, `head_sha`, `base_sha`) from infra's `dispatch-check`, or by hand | fetches the PR head (`refs/pull/<pr>/head`, must equal `head_sha`) and the base, runs `check --base`, posts or updates the one plan comment (`<!-- infra-actions:plan -->`) on the infra PR, and sets the commit status `infra-actions/check` |
| `apply.yml` | `repository_dispatch` `infra-apply` (`sha`, `before`) from infra's `dispatch-apply`, or by hand | first fails unless the repository variable `INFRA_APPLY_ENABLED` is `true` (see "Switch-over"); the commit must be the **head** of infra's `main` (checked before the fetch and again right before the apply, so a stale or out-of-order dispatch applies nothing); `validate --notify apply` with only the Telegram token and chat, then `apply --base <before>`. One concurrency group `infra-apply`, never cancelled. Telegram summary from the tool. |
| `drift.yml` | daily 03:30 UTC, or by hand | ends early with a success and a one-line notice while infra's `main` has no `account.yaml`; otherwise `validate --notify drift` with only the Telegram token and chat, then `drift` on infra's `main`. Telegram summary from the tool. |

### Switch-over (phase E)

Until the switch-over, an accidental push or merge to infra's `main` must apply nothing. Two things hold it:

- **The apply switch.** `apply.yml` fails loudly, as its first step and before any checkout or secret, unless the repository variable `INFRA_APPLY_ENABLED` of this repo is exactly `true`. It is **not set** before phase E.
- **No `account.yaml` on infra's `main`.** The exported files live on a branch with a draft PR until phase E; `drift.yml` skips quietly until `account.yaml` reaches `main`.

At the switch-over, in this order:

1. Announce the freeze on droplet creation and tag changes; stop the Worker's 10-minute sync and its manual `/run`.
2. Re-export from the now-stable state; the check on the export PR must show only the intended changes.
3. Set the variable: `gh variable set INFRA_APPLY_ENABLED --body true -R Lascade-Co/infra-actions` (Settings → Secrets and variables → Actions → Variables).
4. Merge the export PR into infra's `main`. Its push dispatches the first apply; read its Telegram summary.
5. End the freeze.

To stop all applies again at any time, delete the variable or set it to anything but `true`.

Rules kept by all of them (decision 7):

- Only this repo's `main` runs check, apply and drift; every run is pinned to the dispatched `infra` commit.
- Inputs are validated (PR number, 40-hex shas) and reach scripts only through `env:`.
- Actions are pinned by commit SHA.
- Secrets are passed only to the steps that need them.
- Reports go to `$RUNNER_TEMP` and are deleted at the end. They are never uploaded as artifacts, cached or written to the job summary.
- `infra` is fetched with a quiet `git fetch` (`.github/scripts/fetch-infra.sh`), not `actions/checkout`, whose log would show infra commit subjects.

## Run it locally

You need Node 22 or newer.

```sh
npm ci
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run build            # -> dist/

node dist/cli.js validate examples/infra
node dist/cli.js check  <infra-checkout> --out report.md [--json report.json] [--commit <sha>] [--base <base-checkout>]
node dist/cli.js apply  <infra-checkout> --out report.md [--base <checkout-before-the-push>]
node dist/cli.js drift  <infra-checkout> --out report.md
```

Against a real checkout, `check`, `apply` and `drift` call the live APIs with the tokens in the environment, and `apply` writes to them. `test/e2e.test.ts` runs the example checkout through every module against fakes of every API: it applies, then checks that a second apply plans and writes nothing.

Without `--out` nothing is written, and a failed run only says so. The report files hold real names when run against a real checkout: write them outside the checkout (`infra-report*.md` and `infra-plan*.json` are git-ignored as a backstop).

## Layout

```
schema/              JSON Schemas: droplet, profile, account
src/cli.ts           command line (validate | check | apply | drift)
src/engine.ts        run order, stages, frozen droplets, apply gating
src/registry.ts      the modules and their order
src/core/            model types, loader, schema validation, desired state, plan format,
                     Provider interface, report, naming, values, http client, secrets
src/cloudflare/      B1  Cloudflare reconcile (port of the Worker)
src/checks/          B2  cross-file and account checks
src/firewall/        B3  DigitalOcean firewall plan (report-only)
src/droplets/        B4  droplet creation (create-only, with the env's firewall tag)
src/oneuptime/       B5  OneUptime monitors
src/sshconfig/       B6  ssh config on the ssh-config branch
src/output/          B7  PR comment, log line, Telegram, drift report, load-failure alert
src/export/          phase D export of the Worker's live state
examples/infra/      a fake infra checkout
test/                vitest; per-module tests go in test/<module>/
```

## Writing a module

Each module folder has an `index.ts` (the typed contract) and a `README.md`.

- **Providers.** Every provider implements `Provider<O>` from `src/core/plan.ts`:
  - `observe()` is read-only;
  - `diff()` is pure and returns a `ModulePlan`;
  - `apply()` performs only its own create/update/delete ops.
- **Wiring.** Modules are wired in `src/registry.ts`.

A plan is a list of ops:

```ts
{
  provider: "cloudflare",            // digitalocean | cloudflare | oneuptime | github
  module: "cloudflare",              // which module produced it
  kind: "dns-record",                // droplet | firewall | firewall-rule | infra-target | infra-app
                                     // | access-app | tunnel-ingress | dns-record | monitor | ssh-config
  key: "A vpc-shop.example.com",     // stable per kind (conventions in src/core/plan.ts)
  action: "create",                  // create | update | delete | report (shown, never applied)
  before: null,
  after: { content: "10.0.0.11", proxied: false, ttl: 60 },
  reason: "private name for a managed droplet",
  droplet: "shop.example.com",       // groups the PR comment; frozen droplets turn into report (except SSH access)
  pending: true                      // optional: a value is "(known after create)"; apply re-plans first
}
```

## Safety rules

- **`check` and `drift` can't write.** Their API clients refuse every write before it is sent (`ApiClient` with `allowWrites: false`). The only non-GET requests they allow are OneUptime's list endpoints, which are POST reads marked `read: true`.
- **Apply is all-or-nothing.** `apply` writes nothing if any check fails, any read fails or any plan has an error, and the first module that fails stops the run.
- **Create-only droplets.** The tool creates droplets but never resizes, rebuilds or deletes one.
- **Ownership by marker.** The tool changes only objects marked `managed-by:infra-sync`; everything else is left alone. Owned monitors are never deleted.
- **Firewalls are report-only.** `firewall` ops are always `report` until migration Phase 5, and `applyFirewall` refuses anything else.
- **Frozen droplets** (`frozen: true`) are planned but never applied, except their SSH access (the `ssh-access` tag on the existing target and the people on the existing `ssh-` app; see "SSH access").
- **The loader never follows symlinks.** It reads nothing outside `account.yaml`, `droplets/` and `profiles/`, so a pull request can't make the tool read other files.
- **Never add real data to this repo.**
