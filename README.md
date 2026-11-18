# infra-actions

`infra-actions` holds the code and workflows that keep our infrastructure in step with a private data repo. It replaces the infra-sync Cloudflare Worker: droplet files become the input in place of DigitalOcean tags and `web-config.json`.

**Status:** phase B done. Every module is built and tested against fakes of the APIs, never against the live accounts. There are no workflows yet (phase C), and no run against the real accounts yet (phase D: the plan against the live account must show zero changes before the tool takes over from the Worker).

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

- **`validate`:** load and schema only. Needs no secrets and makes no API calls.
- **`check`:** read-only. Runs the checks, observes every API and plans. Its `--out` file is the PR comment, "What happens when this is merged": counts per provider, errors, warnings (awaiting cutover, held droplets and routes the tool doesn't build each have their own heading), the changes grouped by droplet, then the report-only items (the firewall report collapsed per droplet, frozen droplets). `--base` is a checkout of the PR's base: with it, the check also compares the two (a removed droplet file whose droplet still exists is an error, decision 15).
- **`apply`:** all-or-nothing (decision 16).
  1. Runs everything `check` runs. If any check, read or plan has an error, it writes nothing.
  2. Creates droplets from their profiles and writes their managed tags (create-only: it never resizes, rebuilds or deletes one).
  3. Waits for the new droplets' IPs, then plans again. The new plan must be as clean as the first, or nothing else is applied.
  4. Applies Cloudflare, firewall (report-only), OneUptime and the ssh config, in that order. The first module that fails stops the run; the ones after it are skipped and the summary lists them as not applied.
  5. Sends the Telegram summary, also when apply was blocked or stopped.

  `--base` is the commit `main` was at before the push, so the decision-15 check also stops the apply. It catches a removed file only on the merge that removes it.
- **`drift`:** read-only, daily. Reports droplets with no file, hand-made changes (the plan's ops) and the GitHub token's expiry, and sends the summary to Telegram.

Options for every command: `--out <file>` (the detail report, markdown), `--json <file>` (the whole report as JSON, including provider ids and the rendered ssh config) and `--commit <sha>` (the `infra` commit the run is pinned to). Nothing is written unless a path is given.

The exit code is 0 for pass, 1 for fail (errors, failed stages, failed apply ops) and 2 for a usage error.

## Environment variables

| Variable | Used by | For |
|---|---|---|
| `CF_API_TOKEN` | cloudflare | DNS, tunnels, Access apps, SSH targets |
| `DO_TOKEN` | droplets, firewall | droplets and tags (write), firewalls (read) |
| `INFRA_GH_TOKEN` | sshconfig, drift | the ssh-config branch of the `infra` repo; its expiry is in the drift report |
| `ONEUPTIME_API_KEY` | oneuptime | monitors (when `account.yaml` has a `oneuptime` section) |
| `ONEUP_ACCESS_CLIENT_ID`, `ONEUP_ACCESS_CLIENT_SECRET` | oneuptime | the Cloudflare Access service token in front of OneUptime |
| `TELEGRAM_BOT_TOKEN` | apply, drift | the summary to `account.yaml` `telegram.chat_id`; skipped when either is missing |

`validate` needs none. `check`, `apply` and `drift` need all but `TELEGRAM_BOT_TOKEN`; a missing one fails that module's read, and the run fails.

## Modules

| Module | What it manages | Notes |
|---|---|---|
| `checks` (B2) | rules beyond the schema: names in an account zone, references between files, service tokens, UDP routes, swarm rules, removed files | pure; errors block check and apply |
| `droplets` (B4) | creates droplets from profiles; writes the managed tags (`env-*`, `ci-deploy`, `web-staff`, `web-public`) | create-only; other tags never touched |
| `cloudflare` (B1) | SSH targets and the SSH Access app, private (`vpc-`) names, sites (DNS, tunnel routes, Access apps), `allow.tunnel` routes | port of the Worker's reconcile; delete guard rails; UDP routes and port ranges are reported, not built |
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
env: prod                       # prod | staging | internal -> tag env-<env>; new droplets go to that env's region
deploy: true                    # Deploy target (tag ci-deploy): CI may SSH in with the env's deploy token
frozen: false                   # true: plans show its changes, apply skips them

web:                            # the site, through the tunnel (replaces web-staff/web-public + web-config.json)
  exposure: public              # staff (login everywhere) | public (login on protected paths)
  origin: http://{ip}:80        # default https://{ip}:443 (certificate not checked)
  hostnames: [shop.example.net] # extra one-level hostnames
  protected_paths: [/admin]     # public only; default [/admin]
  exceptions:                   # paths open to more callers
    - path: /webhooks/payments
      allow: everyone
    - path: /api/partner
      allow:
        ips: [198.51.100.0/24]
        service_tokens: [uptime]   # names from account.yaml cloudflare.service_tokens
  health_path: /healthcheck/    # default /healthcheck/ with deploy, else /
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

Only `name` is required. A minimal adopted droplet is just `name: build.example.com`, with `env` if it has one.

### Profiles and account config

- **`profiles/<name>.yaml`** ([schema](schema/profile.schema.json)) holds `size`, `image` (a pinned slug) and `user_data`, which names a cloud-init file in `profiles/user-data/`. The region isn't part of a profile: it follows the droplet's `env`. The VPC is always the region's default. The tool never resizes, rebuilds or deletes a droplet (create-only).
- **`account.yaml`** ([schema](schema/account.schema.json)) holds account-level values:
  - the Cloudflare account id, team domain and zones;
  - the tunnel per region;
  - the staff policy id;
  - the SSH admin emails;
  - the service tokens by name;
  - the CI deploy tokens per env;
  - the delete guard rails;
  - the region per env;
  - the OneUptime project;
  - the `infra` repo and its ssh-config branch;
  - the Telegram chat;
  - the ssh config title.

  It holds no secrets.

See [`examples/infra/`](examples/infra/) for a complete fake checkout.

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
src/droplets/        B4  droplet creation (create-only) and tags
src/oneuptime/       B5  OneUptime monitors
src/sshconfig/       B6  ssh config on the ssh-config branch
src/output/          B7  PR comment, log line, Telegram, drift report
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
  kind: "dns-record",                // droplet | droplet-tags | firewall | firewall-rule | infra-target | infra-app
                                     // | access-app | tunnel-ingress | dns-record | monitor | ssh-config
  key: "A vpc-shop.example.com",     // stable per kind (conventions in src/core/plan.ts)
  action: "create",                  // create | update | delete | report (shown, never applied)
  before: null,
  after: { content: "10.0.0.11", proxied: false, ttl: 60 },
  reason: "private name for a managed droplet",
  droplet: "shop.example.com",       // groups the PR comment; frozen droplets turn into report
  pending: true                      // optional: a value is "(known after create)"; apply re-plans first
}
```

## Safety rules

- **`check` and `drift` can't write.** Their API clients refuse every non-GET request before it is sent (`ApiClient` with `allowWrites: false`).
- **Apply is all-or-nothing.** `apply` writes nothing if any check fails, any read fails or any plan has an error, and the first module that fails stops the run.
- **Create-only droplets.** The tool creates droplets but never resizes, rebuilds or deletes one.
- **Ownership by marker.** The tool changes only objects marked `managed-by:infra-sync`; everything else is left alone. Owned monitors are never deleted.
- **Firewalls are report-only.** `firewall` ops are always `report` until migration Phase 5, and `applyFirewall` refuses anything else.
- **Frozen droplets** (`frozen: true`) are planned but never applied.
- **The loader never follows symlinks.** It reads nothing outside `account.yaml`, `droplets/` and `profiles/`, so a pull request can't make the tool read other files.
- **Never add real data to this repo.**
