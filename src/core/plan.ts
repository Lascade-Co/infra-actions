// The plan format and the Provider interface every module implements.
//
// A plan is a flat list of operations. Each says which provider and object it touches,
// what happens to it and why. `before`/`after` are the object's relevant fields as plain
// JSON (what the detail file and the PR comment show); they are never logged.

import type { Diagnostic } from "./diagnostics.js";
import type { DesiredState } from "./desired.js";
import type { AccountConfig } from "./model.js";
import type { Secrets } from "./secrets.js";
import type { FetchFn } from "./http.js";
import type { CredentialStatus } from "./report.js";

export type ProviderName = "digitalocean" | "cloudflare" | "oneuptime" | "github";

/** Which module produced an op (a provider can be planned by more than one module). */
export type ModuleName = "droplets" | "cloudflare" | "firewall" | "oneuptime" | "sshconfig";

/**
 * Object kinds, per provider. `key` conventions (stable, unique per kind):
 *  digitalocean droplet           droplet name
 *  digitalocean droplet-tags      droplet name
 *  digitalocean firewall          firewall name
 *  digitalocean firewall-rule     "<firewall name> <inbound|outbound> <protocol>/<ports> <source>"
 *  cloudflare   infra-target      target hostname (= droplet name)
 *  cloudflare   infra-app         Access app name
 *  cloudflare   access-app        Access app destination (host or host/path, lowercase)
 *  cloudflare   tunnel-ingress    "<tunnel id> <hostname>[ <path>]"
 *  cloudflare   dns-record        "<type> <name>"
 *  oneuptime    monitor           "<hostname><path>"
 *  github       ssh-config        "<repo>@<branch>:<file>"
 */
export type ResourceKind =
  | "droplet"
  | "droplet-tags"
  | "firewall"
  | "firewall-rule"
  | "infra-target"
  | "infra-app"
  | "access-app"
  | "tunnel-ingress"
  | "dns-record"
  | "monitor"
  | "ssh-config";

/**
 * - create / update / delete: apply performs it.
 * - report: shown in the plan, never performed (firewall rules until migration Phase 5,
 *   changes for a frozen droplet, anything the tool may not touch).
 */
export type Action = "create" | "update" | "delete" | "report";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface PlanOp {
  provider: ProviderName;
  module: ModuleName;
  kind: ResourceKind;
  key: string;
  action: Action;
  /** The object's relevant fields now; null for create. */
  before: Json | null;
  /** The object's relevant fields after apply; null for delete. May hold KNOWN_AFTER_CREATE. */
  after: Json | null;
  /** One sentence a reviewer understands: why this op exists. */
  reason: string;
  /** The droplet file this op stems from, if any (grouping in the PR comment, frozen droplets). */
  droplet?: string;
  /** Provider ids apply needs (record id, app id...). Not shown to people. */
  ids?: Record<string, string>;
  /** True while a value in `after` is KNOWN_AFTER_CREATE; apply re-plans before performing it. */
  pending?: boolean;
  /**
   * cloudflare infra-target ops whose change alters who may SSH into the droplet (decision 18):
   * the people and usernames before and after. Shown in the PR comment, never sent to an API.
   */
  sshAccess?: { before: SshAccess; after: SshAccess };
}

/** Who may SSH into a droplet through the infrastructure apps, and as which users. Sorted. */
export interface SshAccess {
  emails: string[];
  usernames: string[];
}

/** What one module's diff returns. */
export interface ModulePlan {
  module: ModuleName;
  ops: PlanOp[];
  /** Objects already as desired (counted, not listed). */
  unchanged: number;
  /** Conflicts, skipped objects, guard-rail blocks... */
  diagnostics: Diagnostic[];
}

export interface OpFailure {
  op: PlanOp;
  /** Error text without secrets (API errors name method and path only). */
  error: string;
}

export interface ApplyResult {
  module: ModuleName;
  applied: PlanOp[];
  failed: OpFailure[];
  /** Ops not performed: report ops, frozen droplets, steps after a failure... */
  skipped: Array<{ op: PlanOp; reason: string }>;
}

export type RunMode = "check" | "apply" | "drift";

/** Everything a module may use at run time. Built once per run by the engine. */
export interface RunContext {
  mode: RunMode;
  account: AccountConfig;
  secrets: Secrets;
  fetch: FetchFn;
  /** true only in apply. Every API client built from this context refuses writes otherwise. */
  allowWrites: boolean;
  now: () => Date;
  /** Waits; injectable so tests don't sleep. */
  sleep: (ms: number) => Promise<void>;
}

/**
 * A module that owns one slice of the outside world.
 *  - observe(): read-only API calls; returns the module's own observed type.
 *  - diff(): pure; never does I/O.
 *  - apply(): performs create/update/delete ops of this module, in its own safe order;
 *    never performs `report` ops. Only ever called in mode "apply".
 */
export interface Provider<O> {
  readonly module: ModuleName;
  observe(desired: DesiredState): Promise<O>;
  diff(desired: DesiredState, observed: O): ModulePlan;
  apply(ops: PlanOp[], observed: O): Promise<ApplyResult>;
  /** Credentials whose expiry this module can see (e.g. the GitHub token), for the drift report. */
  credentials?(observed: O): CredentialStatus[];
}

/** Signature of every module's factory. */
export type ProviderFactory<O> = (ctx: RunContext) => Provider<O>;

export interface OpCounts {
  create: number;
  update: number;
  delete: number;
  report: number;
}

export function countOps(ops: readonly PlanOp[]): OpCounts {
  const c: OpCounts = { create: 0, update: 0, delete: 0, report: 0 };
  for (const op of ops) c[op.action]++;
  return c;
}

/** Changes apply would perform (not report ops). */
export const isChange = (op: PlanOp): boolean => op.action !== "report";
