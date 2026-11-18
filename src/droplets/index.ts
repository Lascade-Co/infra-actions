// B4: droplet creation (create-only) and the DigitalOcean tags written from droplet files.
// Contract only; see README.md in this folder.

import type { DesiredDroplet, DesiredState } from "../core/desired.js";
import { notImplemented } from "../core/diagnostics.js";
import type { ObservedDroplet, DropletsObserved } from "../core/observed.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";

export type { DropletsObserved } from "../core/observed.js";

/** The droplets provider is observed first: the engine builds the desired state from it. */
export interface DropletsProvider extends Provider<DropletsObserved> {
  /** GET /v2/droplets (all pages). Needs no desired state. observe() returns the same. */
  observeDroplets(): Promise<DropletsObserved>;
}

/** POST /v2/droplets body for a droplet with status "create". */
export interface DoCreateDropletBody {
  name: string;
  region: string;
  size: string;
  image: string;
  /** The profile's cloud-init text. No vpc_uuid: the region's default VPC is used. */
  user_data: string;
  tags: string[];
  monitoring: boolean;
  ipv6: boolean;
  backups: boolean;
}

/** Maps one DigitalOcean API droplet object to the shared observed shape. */
export function toObservedDroplet(_apiDroplet: unknown): ObservedDroplet {
  return notImplemented("droplets.toObservedDroplet");
}

/** The create request for a droplet with status "create" (profile + env region + managed tags). */
export function createRequest(_d: DesiredDroplet): DoCreateDropletBody {
  return notImplemented("droplets.createRequest");
}

/**
 * Pure. Ops:
 *  - kind "droplet", action "create", for each status "create" droplet (after: the create request, user_data elided);
 *  - kind "droplet-tags", action "update", when the managed tags (MANAGED_TAGS) on an existing droplet differ
 *    from desired.tags; before/after list managed tags only; other tags are never touched.
 * Never resize, rebuild or delete: differences in size/image/region are at most info diagnostics.
 */
export function planDroplets(_desired: DesiredState, _observed: DropletsObserved): ModulePlan {
  return notImplemented("droplets.planDroplets");
}

/**
 * Performs the ops in order: creates, then waits (ctx.sleep, bounded) until every new droplet is
 * active with a private IPv4, then tag changes. Returns ApplyResult; the engine re-observes after.
 */
export async function applyDroplets(_ctx: RunContext, _ops: PlanOp[]): Promise<ApplyResult> {
  return notImplemented("droplets.applyDroplets");
}

export function createDropletsProvider(ctx: RunContext): DropletsProvider {
  const observeDroplets = (): Promise<DropletsObserved> => notImplemented("droplets.observeDroplets");
  return {
    module: "droplets",
    observeDroplets,
    observe: () => observeDroplets(),
    diff: (desired, observed) => planDroplets(desired, observed),
    apply: (ops) => applyDroplets(ctx, ops),
  };
}
