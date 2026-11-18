# checks (B2): rules beyond the schema

These checks are pure functions that return `Diagnostic[]`. They never throw for a broken rule, never do I/O and never call apply code. Each diagnostic gets a stable `code`, the `file` (`droplets/<name>.yaml`), the dotted `path` and the `droplet`, so the PR comment can point at the exact line. Errors make `check` fail and stop `apply`. Warnings and info are shown in the plan.

## What the loader already does (don't repeat it)

`src/core/loader.ts` handles everything inside a single file:

- the layout;
- YAML (one document per file, no duplicate keys);
- the JSON Schema;
- name = file name;
- ports, CIDRs and `who` syntax;
- duplicate or clashing paths and reserved `ssh-`/`vpc-` prefixes;
- monitor hostnames, a profile's `user_data` file, and account-internal references (CI token names, a tunnel for every env region).

## What B2 must do

**`checkConfig(config)`** works offline and runs on every PR:

- **Naming.** Every droplet name is in an account zone (`flattenName` in `src/core/naming.ts`). No two names flatten to the same `ssh-` name.
- **Site hostnames and `allow.tunnel[].route`.**
  - Each must be a One-level name in an account zone (`isOneLevel`).
  - No hostname or route may be claimed by two files, or equal another droplet's name.
- **References.**
  - `profile` exists in `profiles/`.
  - `allow.droplet[].from` names a droplet file. Code `unknown-droplet`: this also covers removing a droplet that others still list.
  - Every `service-token:<name>` and exception `service_tokens` entry is a key of `account.cloudflare.service_tokens`.
- **Deploy.** `deploy: true` with an empty `ci_deploy_tokens[env]` is a warning (the Worker warns too).
- **Tunnel UDP.** `allow.tunnel` with `/udp` is only valid with `who: [staff]`. The message gives the reason: service tokens are TCP only, and UDP goes through the client's private-network route.
- **Swarm.** At least one `role: manager` per cluster. All members agree on `encrypted_overlay`.

**`checkDesired(desired)`** runs after the droplets are observed:

- **Swarm members share one region.** A public advertise address can't be seen from the API; say so in the docs, don't guess.
- **`allow.droplet` across regions** gets a warning: the public IP is used, with no VPC peering.
- **A file with a `profile` for a droplet that already exists** gets an info diagnostic: the profile is ignored, because droplets are create-only.
- **A droplet in a region with no tunnel** gets a warning: it has no Cloudflare side.

**`checkChange(base, head)`** runs only with `check --base <dir>`, the PR's base checkout:

- **A removed droplet file gets a warning.** Its Cloudflare side, monitors and ssh config entry will be deleted. The droplet itself keeps running, because the tool never deletes droplets.
- **A changed `profile` on an existing droplet gets an info diagnostic:** nothing happens.

## Inputs and outputs

- **Inputs:**
  - `InfraConfig` (`src/core/model.ts`);
  - `DesiredState` (`src/core/desired.ts`).
- **Output:** `Diagnostic[]` (`src/core/diagnostics.ts`).

Tests go in `test/checks/` and use fake data only.

## Port from

The infra-sync Worker has no such checks. It does have related rules:

- `src/config.ts` `parseWebConfig`: hostname claimed twice;
- `src/plan.ts`: duplicate and flattening collisions, one-level names.
