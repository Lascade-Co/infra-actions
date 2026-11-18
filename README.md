# infra-actions

`infra-actions` holds the code and workflows that keep our infrastructure in step with a private data repo. It replaces the infra-sync Cloudflare Worker: droplet files become the input in place of DigitalOcean tags and `web-config.json`.

**Status:** B0 skeleton. These parts work:

- the file formats (JSON Schemas);
- the loader;
- the desired-state model;
- the plan format;
- the engine and the CLI.

The modules (Cloudflare, checks, firewall, droplets, OneUptime, ssh config, output) are contracts that throw `NotImplementedError`; see "Modules" below. There are no workflows yet.

## Two repos

| Repo | Visibility | Holds |
|---|---|---|
| `Lascade-Co/infra` | private | **Data only.** `account.yaml`, `droplets/*.yaml`, `profiles/*.yaml` with `profiles/user-data/*`, and the `ssh-config` branch. Staff propose changes by pull request from a fork. Nothing in it is ever executed. |
| `Lascade-Co/infra-actions` (this repo) | public | **All code and workflows.** `infra` dispatches its pull requests (check) and its pushes to `main` (apply) here; each run is pinned to the dispatched `infra` commit. |

Because this repo is public:

- It contains no real hostnames, IPs, account ids or droplet names.
- Examples and test fixtures use `example.com`/`example.net`, RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), `10.0.0.x` and placeholder UUIDs.
- The CLI prints one line of counts and PASS/FAIL. Everything with names goes to a file (`--out`), which the workflow posts as a comment on the private `infra` pull request. Plans and reports are never uploaded as artifacts.
- Secrets come only from environment variables, and are never printed or written to files:
  - `CF_API_TOKEN`, `DO_TOKEN`;
  - `INFRA_GH_TOKEN`;
  - `ONEUPTIME_API_KEY`, `ONEUP_ACCESS_CLIENT_ID`, `ONEUP_ACCESS_CLIENT_SECRET`;
  - `TELEGRAM_BOT_TOKEN`.

## How it works

There's no state file. The tool reads the live accounts, compares them with the files and plans the difference. It recognises its own objects by the `managed-by:infra-sync` marker, the same one the Worker uses, so it adopts what the Worker created.

```
infra checkout ──load+validate──▶ InfraConfig ──checks──▶ diagnostics
                                       │
DigitalOcean droplets ──observe──▶ desired state (files ⨝ droplets, defaults applied)
                                       │
         each module: observe ─▶ diff ─▶ plan ops ─▶ (apply only) apply
```

- **`check`:** read-only. Validates, checks and plans, and writes the plan to the detail file (the PR comment).
- **`apply`:**
  1. Stops before writing anything if the plan has any error.
  2. Creates droplets and fixes their tags.
  3. Waits for the new droplets' IPs, then re-plans.
  4. Applies Cloudflare, firewall (report-only), OneUptime and the ssh config, in that order.
  5. Sends the Telegram summary.
- **`drift`:** read-only. Reports droplets with no file, hand-made changes (the plan's ops) and token expiry.
- **`validate`:** load and schema only. Needs no secrets and makes no API calls.

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

node dist/cli.js validate examples/infra --out /tmp/report.md
node dist/cli.js check  <infra-checkout> --out report.md [--json report.json] [--commit <sha>] [--base <base-checkout>]
node dist/cli.js apply  <infra-checkout> --out report.md
node dist/cli.js drift  <infra-checkout> --out report.md
```

The exit code is 0 for pass, 1 for fail (errors, failed or unimplemented stages, failed apply ops) and 2 for a usage error. Without `--out`, details go to `./infra-report.md` (git-ignored).

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

## Modules

Each module folder has an `index.ts` (the typed contract) and a `README.md` (what to build, its inputs and outputs, what to port from the Worker).

- **Providers.** Every provider implements `Provider<O>` from `src/core/plan.ts`:
  - `observe()` is read-only;
  - `diff()` is pure and returns a `ModulePlan`;
  - `apply()` performs only its own create/update/delete ops.
- **Wiring.** Modules are wired in `src/registry.ts`. A module author edits only their own folder and `test/<module>/`.

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
- **Errors block apply.** `apply` writes nothing if any check fails, any read fails or any module isn't implemented.
- **Firewalls are report-only.** `firewall` ops are always `report` until migration Phase 5, and `applyFirewall` refuses anything else.
- **The loader never follows symlinks.** It reads nothing outside `account.yaml`, `droplets/` and `profiles/`, so a pull request can't make the tool read other files.
- **Never add real data to this repo.**
