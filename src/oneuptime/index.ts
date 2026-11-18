// B5: OneUptime monitors from droplet files.
// Contract only; see README.md in this folder.

import type { DesiredState } from "../core/desired.js";
import { notImplemented } from "../core/diagnostics.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";

/** A monitor as B5 reads it from OneUptime (fields it compares). */
export interface OneUptimeMonitor {
  id: string;
  name: string;
  description?: string;
  /** e.g. https://app.example.com/healthcheck/ */
  url?: string;
  /** Raw API object, for fields B5 compares but this skeleton doesn't name. */
  raw: unknown;
}

export interface OneUptimeObserved {
  /** Monitors the tool owns (marker DNS_COMMENT_MARKER in their description). */
  owned: OneUptimeMonitor[];
  /** Number of monitors the tool does not own (never touched, counted for the drift report). */
  foreignCount: number;
}

/**
 * Read-only: list the project's monitors. Requests go through Access with the service token
 * (ONEUP_ACCESS_CLIENT_ID / ONEUP_ACCESS_CLIENT_SECRET headers) plus ONEUPTIME_API_KEY.
 */
export async function observeMonitors(_ctx: RunContext): Promise<OneUptimeObserved> {
  return notImplemented("oneuptime.observeMonitors");
}

/**
 * Pure: one HTTP monitor per DesiredDroplet.monitors entry (key "<hostname><path>"), alerting
 * through account.oneuptime.on_call_policy_ids. Create and update owned monitors only; an owned
 * monitor no longer in any file is a `report` op (delete by hand). Foreign monitors never appear.
 */
export function planMonitors(_desired: DesiredState, _observed: OneUptimeObserved): ModulePlan {
  return notImplemented("oneuptime.planMonitors");
}

export async function applyMonitors(_ctx: RunContext, _ops: PlanOp[]): Promise<ApplyResult> {
  return notImplemented("oneuptime.applyMonitors");
}

export function createOneUptimeProvider(ctx: RunContext): Provider<OneUptimeObserved> {
  return {
    module: "oneuptime",
    observe: () => observeMonitors(ctx),
    diff: (desired, observed) => planMonitors(desired, observed),
    apply: (ops) => applyMonitors(ctx, ops),
  };
}
