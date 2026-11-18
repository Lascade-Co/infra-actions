# droplets (B4): droplet creation (create-only) and tags

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
    - `after` is the create request without `user_data`: name, region (from env), size and image (from the profile), tags.
    - The reason names the profile.
  - **Existing droplets whose managed tags differ from `DesiredDroplet.tags`:** one `kind: "droplet-tags"`, `action: "update"` op. `before` and `after` list **managed tags only** (`MANAGED_TAGS` in `src/core/constants.ts`). Tags outside that list are never added or removed.
  - **Create-only:** never resize, rebuild, rename or delete. A droplet whose size, image or region differs from its profile gets at most an info diagnostic.
- **`createRequest(d)`:**
  - **Size, image and user data:** `size`, `image` and `user_data` (`userDataText`) from the profile.
  - **Region:** from `d.region`, which is `account.digitalocean.regions[env]`.
  - **VPC:** the region's default (leave `vpc_uuid` out).
  - **Tags:** `d.tags`.
  - **Flags:** `monitoring: true`, `ipv6: false`, `backups: false`, unless the owner decides otherwise.
- **`applyDroplets(ctx, ops)`:**
  - **Create:** `POST /v2/droplets`.
  - **Wait:** with `ctx.sleep`, bounded at about 5 minutes, until each new droplet is `active` with a private IPv4. Report a timeout as a failed op.
  - **Tags:** `POST /v2/tags` (when the tag is missing), then `POST`/`DELETE /v2/tags/{tag}/resources`.
  - **Afterwards:** the engine re-observes and re-plans everything else.

## Inputs and outputs

- **Input:**
  - `DesiredState`, in particular `status`, `profile`, `region`, `tags` and `observed`;
  - `DropletsObserved`.
- **Output:** a `ModulePlan` with droplet and droplet-tags ops, and an `ApplyResult`.

## Port from

The infra-sync Worker never wrote to DigitalOcean. Port only `src/clients/digitalocean.ts` (`listDroplets`) and the `Droplet` type from `src/types.ts`. For creation, see decision 10 of `iac-repo-design.md`: profiles, the region by env, cloud-init. Tests go in `test/droplets/` and use fake data only.
