// B1: Cloudflare reconcile (ported from the infra-sync Worker).
// Contract only; see README.md in this folder.

import type { DesiredState } from "../core/desired.js";
import { notImplemented } from "../core/diagnostics.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";
import type { CloudflareObserved } from "./types.js";

export type * from "./types.js";

/**
 * Read-only: zones (account), infrastructure targets, Access apps, the configuration of every
 * tunnel in account.cloudflare.tunnels, and every DNS record of every zone. A failed tunnel or
 * zone read is kept as { error } so the plan can fail closed (no deletes), as in the Worker.
 */
export async function observeCloudflare(_ctx: RunContext): Promise<CloudflareObserved> {
  return notImplemented("cloudflare.observeCloudflare");
}

/**
 * Pure: the Worker's buildPlan/planWeb, with droplet files as input instead of tags +
 * web-config.json. Returns create/update/delete ops for targets, the infrastructure app,
 * ssh- apps, healthcheck bypass apps, site apps, tunnel ingress, ssh-/vpc-/site DNS records,
 * plus allow.tunnel routes and their Access apps. Only objects carrying the infra-sync
 * marker are ever updated or deleted. Diagnostics carry the Worker's skipped/conflicts/
 * warnings/errors. Delete guard rails (account.cloudflare.guards) turn deletes into
 * `report` ops with the reason when exceeded.
 */
export function planCloudflare(_desired: DesiredState, _observed: CloudflareObserved): ModulePlan {
  return notImplemented("cloudflare.planCloudflare");
}

/** Performs the ops in the Worker's fail-closed order (create: target -> app -> ingress -> DNS; delete: DNS -> ingress -> app -> target). */
export async function applyCloudflare(_ctx: RunContext, _ops: PlanOp[], _observed: CloudflareObserved): Promise<ApplyResult> {
  return notImplemented("cloudflare.applyCloudflare");
}

export function createCloudflareProvider(ctx: RunContext): Provider<CloudflareObserved> {
  return {
    module: "cloudflare",
    observe: () => observeCloudflare(ctx),
    diff: (desired, observed) => planCloudflare(desired, observed),
    apply: (ops, observed) => applyCloudflare(ctx, ops, observed),
  };
}
