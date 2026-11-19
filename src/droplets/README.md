# droplets (B4): droplet creation (create-only)

The engine observes this module first and applies it first: every other module plans from the droplets it reads, and new droplets must have IPs before DNS, routes or firewall rules can point at them.

## What it must do

- **`observeDroplets()`:** read `GET /v2/droplets` (all pages) through `ApiClient` with `DO_TOKEN`, and map each droplet with `toObservedDroplet` (`src/core/observed.ts`).
  - Keep the Worker's fail-closed checks from `src/clients/digitalocean.ts`:
    - the count must match `meta.total`;
    - an empty list is an error;
    - missing tags mean the token lacks `tag:read`.
  - Never filter: droplets with no file are the drift report's business.
- **`planDroplets(desired, observed)`** (pure):
  - **`status: "create"`:** one `kind: "droplet"`, `action: "create"` op.
    - `after` is the create request without `user_data`: name, region (from env), size and image (from the profile), tags (the env's old firewall tag).
    - The reason names the profile and the tag.
  - **Existing droplets get no op** (decision 20): the droplet file is the only source of truth, and no tag is written to or removed from an existing droplet. The `env-*`, `ci-deploy`, `web-staff` and `web-public` tags the Worker read stay as they are.
  - **Create-only:** never resize, rebuild, rename or delete. A droplet whose size, image or region differs from its profile gets at most an info diagnostic.
- **`createRequest(d)`:**
  - **Size, image and user data:** `size`, `image` and `user_data` (`userDataText`) from the profile.
  - **Region:** from `d.region`, which is `account.digitalocean.regions[env]`.
  - **VPC:** the region's default (leave `vpc_uuid` out).
  - **Tags:** `d.tags`: only the old firewall tag of the droplet's env (`FIREWALL_TAGS`: prod → `production`, staging → `staging`, internal → `internal`, the tags today's firewalls are attached by), so the firewalls cover it from birth until migration Phase 5 attaches firewalls by droplet id. DigitalOcean creates a missing tag with the droplet, which needs the token's `tag:create` scope.
  - **Flags:** `monitoring: true`, `ipv6: false`, `backups: false`, unless the owner decides otherwise.
- **`applyDroplets(ctx, ops)`:**
  - **Create:** `POST /v2/droplets`.
  - **Wait:** with `ctx.sleep`, bounded at about 5 minutes, until each new droplet is `active` with a private IPv4. Report a timeout as a failed op.
  - **Afterwards:** the engine re-observes and re-plans everything else.

## Inputs and outputs

- **Input:**
  - `DesiredState`, in particular `status`, `profile`, `region`, `tags` and `observed`;
  - `DropletsObserved`.
- **Output:** a `ModulePlan` with droplet create ops, and an `ApplyResult`.

## Port from

The infra-sync Worker never wrote to DigitalOcean. Port only `src/clients/digitalocean.ts` (`listDroplets`) and the `Droplet` type from `src/types.ts`. For creation, see decision 10 of `iac-repo-design.md`: profiles, the region by env, cloud-init. Tests go in `test/droplets/` and use fake data only.

## As built

- **Files:** `api.ts` (the DigitalOcean endpoints, fail-closed list) and `index.ts` (map, plan, apply, provider).
- **Plan shapes:** a create op's `after` is the create body without `user_data`, plus `profile`.
- **`user_data` never travels in an op.** The provider keeps the create bodies from its last `diff()` and passes them to `applyDroplets(ctx, ops, { requests })`. A create op without a body is refused.
- **Apply order and stops:**
  1. Refuse anything that isn't a droplets create, before any request (a `droplet-tags` op too: the tool never writes tags).
  2. List all droplets again; a create whose name now exists is not sent.
  3. Each create is sent once. An error is never retried: the op fails and every later op is skipped (a later apply sees the droplet by name if the request did create it).
  4. Wait up to `MAX_POLLS` × `POLL_INTERVAL_MS` (60 × 5 s) for `active` with a public and a private IPv4; failed reads are retried until then; a timeout fails the op.
  5. Droplets created before a stop stay in `applied`.
- **Profile drift** (size, image, or region not the env's) of an existing droplet whose file names a profile: info diagnostic `droplet-profile-drift`, never an op.
