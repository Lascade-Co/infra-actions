// B3: firewall plan, REPORT-ONLY until migration Phase 5.
// Contract only; see README.md in this folder.

import type { DesiredState } from "../core/desired.js";
import { notImplemented } from "../core/diagnostics.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";

/** A DigitalOcean cloud firewall as read from GET /v2/firewalls (fields B3 needs). */
export interface DoFirewall {
  id: string;
  name: string;
  status?: string;
  droplet_ids: number[];
  tags: string[];
  inbound_rules: Array<{
    protocol: "tcp" | "udp" | "icmp";
    /** "8443", "8000-8010", "all" or "0" (icmp). */
    ports: string;
    sources: { addresses?: string[]; droplet_ids?: number[]; tags?: string[]; load_balancer_uids?: string[] };
  }>;
  outbound_rules: Array<{
    protocol: "tcp" | "udp" | "icmp";
    ports: string;
    destinations: { addresses?: string[]; droplet_ids?: number[]; tags?: string[]; load_balancer_uids?: string[] };
  }>;
}

export interface FirewallObserved {
  firewalls: DoFirewall[];
}

/** Where a desired rule comes from in the droplet file. */
export type RuleOrigin = "allow.droplet" | "allow.ip" | "swarm";

/** One inbound rule a droplet file implies, before it is mapped onto DigitalOcean firewalls. */
export interface DesiredFirewallRule {
  /** The callee: the droplet whose file declares the rule. */
  droplet: string;
  protocol: "tcp" | "udp";
  /** "8443" or "8000-8010". */
  ports: string;
  /** The caller. */
  source:
    | { kind: "droplet"; name: string; address: string; addressKind: "private" | "public" }
    | { kind: "address"; cidr: string };
  origin: RuleOrigin;
  /** allow.droplet across regions (no VPC peering): public IP used; flagged in the PR comment. */
  crossRegion?: boolean;
  note?: string;
}

/**
 * Pure: every inbound rule implied by allow.droplet, allow.ip and swarm (all-pairs: 2377/tcp to
 * managers, 7946/tcp+udp and 4789/udp between members). ESP (protocol 50, encrypted overlay) can't
 * be expressed in a DigitalOcean firewall: return a warning diagnostic for it, no rule.
 * Same region -> caller's private IP; different region -> public IP and crossRegion: true.
 */
export function firewallRules(_desired: DesiredState): { rules: DesiredFirewallRule[]; diagnostics: ModulePlan["diagnostics"] } {
  return notImplemented("firewall.firewallRules");
}

/**
 * Pure: diff the desired rules against today's firewalls. EVERY op has action "report" (kind
 * "firewall" or "firewall-rule"), reason saying what would change. Never create/update/delete.
 */
export function planFirewall(_desired: DesiredState, _observed: FirewallObserved): ModulePlan {
  return notImplemented("firewall.planFirewall");
}

/** Read-only: GET /v2/firewalls (all pages). */
export async function observeFirewalls(_ctx: RunContext): Promise<FirewallObserved> {
  return notImplemented("firewall.observeFirewalls");
}

/** Report-only: performs nothing. Returns every op as skipped; throws if handed a non-report op. */
export async function applyFirewall(ops: PlanOp[]): Promise<ApplyResult> {
  const bad = ops.find((o) => o.action !== "report");
  if (bad) throw new Error(`firewall is report-only until migration Phase 5; refusing ${bad.action} ${bad.key}`);
  return { module: "firewall", applied: [], failed: [], skipped: ops.map((op) => ({ op, reason: "report-only" })) };
}

export function createFirewallProvider(ctx: RunContext): Provider<FirewallObserved> {
  return {
    module: "firewall",
    observe: () => observeFirewalls(ctx),
    diff: (desired, observed) => planFirewall(desired, observed),
    apply: (ops) => applyFirewall(ops),
  };
}
