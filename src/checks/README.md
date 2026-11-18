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
- **`allow.droplet` across regions** gets a warning saying the caller's PUBLIC IP will be allowed (there is no VPC peering), and which IP that is.
- **A file with a `profile` for a droplet that already exists** gets an info diagnostic: the profile is ignored, because droplets are create-only.
- **A droplet in a region with no tunnel** gets a warning: it has no Cloudflare side.

**`checkChange(base, head, desired?)`** runs only with `check --base <dir>`, the PR's base checkout. The engine calls it after the droplets are observed and passes the head's desired state (its `unmanaged` list holds every droplet that has no file in the head):

- **A removed droplet file whose droplet still exists in DigitalOcean is an error** (`removed-droplet-exists`, decision 15). Retiring a droplet means deleting it by hand first (the tool is create-only), then merging the PR that removes its file. A renamed file counts as a removal, so the droplet must be renamed in DigitalOcean first.
- **If the droplets couldn't be read, a removed file is an error** (`removed-droplet-unverified`): the check fails safe.
- **A removed droplet file that other files still list in `allow.droplet` is an error** (`removed-droplet-referenced`). It is one diagnostic on the removed file, naming each referrer and its field. `checkConfig` also reports `unknown-droplet` on each referrer.
- **A removed file whose droplet is gone gets a warning** (`droplet-file-removed`). Its Cloudflare side is deleted on merge (SSH route, private name, site, tunnel routes, Access apps), along with its ssh config entry. Its monitors are listed for removal by hand, because owned monitors are never deleted (decision 16).
- **A changed `profile` on an existing droplet gets an info diagnostic** (`profile-changed`): nothing happens.

Swarm peers need no reference check. Membership is by cluster name, so every peer is a droplet file by construction. Removing one is covered by the rules above and by the manager rule in `checkConfig`.

## Diagnostic codes

| Code | Level | Where |
|---|---|---|
| `naming`, `name-collision` | error | `name` |
| `not-in-zone`, `not-one-level` | error | `name` (with `web`), `web.hostnames[i]`, `allow.tunnel[i].route` |
| `hostname-claimed` | error | each claimer except a droplet's own name |
| `unknown-profile` | error | `profile` |
| `unknown-droplet` | error | `allow.droplet[i].from` |
| `unknown-service-token` | error | `allow.tunnel[i].who[j]`, `web.exceptions[i].allow.service_tokens` |
| `no-deploy-token` | warning | `deploy` |
| `udp-needs-staff` | error | `allow.tunnel[i].port` |
| `swarm-no-manager` | error | `swarm.role` of every member |
| `swarm-overlay-mismatch` | error | `swarm.encrypted_overlay` of the minority |
| `swarm-region` | error | `swarm.cluster` of members outside the main region |
| `cross-region-caller` | warning | `allow.droplet[i].from` |
| `profile-ignored` | info | `profile` |
| `region-without-tunnel` | warning | the file |
| `removed-droplet-exists`, `removed-droplet-unverified`, `removed-droplet-referenced` | error | the removed file |
| `droplet-file-removed` | warning | the removed file |
| `profile-changed` | info | `profile` |

The loader keeps no YAML positions in `InfraConfig`, so these diagnostics have `file` and `path` but no `line`.

**Not checked:** a swarm member's advertise address. The API doesn't show it, so the tool can't tell whether a member advertises a public address. Check it by hand (`docker node inspect`).

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
