// Fake run reports for the output tests. Every name, IP and id is fake.

import { KNOWN_AFTER_CREATE } from "../../src/core/constants.js";
import type { ModulePlan, PlanOp } from "../../src/core/plan.js";
import { newReport, type RunReport } from "../../src/core/report.js";

export const op = (over: Partial<PlanOp> & Pick<PlanOp, "kind" | "key">): PlanOp => ({
  provider: "cloudflare",
  module: "cloudflare",
  action: "create",
  before: null,
  after: {},
  reason: "test",
  ...over,
});

export const OPS = {
  vpc: op({ kind: "dns-record", key: "A vpc-shop.example.com", before: { content: "10.0.0.9" }, after: { content: "10.0.0.11" }, action: "update", reason: "private IP changed", droplet: "shop.example.com" }),
  route: op({ kind: "tunnel-ingress", key: "00000000-0000-4000-8000-000000000001 shop.example.com", after: { service: "https://203.0.113.11:443" }, reason: "site route", droplet: "shop.example.com" }),
  newDroplet: op({ provider: "digitalocean", module: "droplets", kind: "droplet", key: "new.example.com", after: { region: "blr1", ip: KNOWN_AFTER_CREATE }, reason: "droplet file with profile ubuntu-6", droplet: "new.example.com" }),
  newDns: op({ kind: "dns-record", key: "A vpc-new.example.com", after: { content: KNOWN_AFTER_CREATE }, reason: "private name", droplet: "new.example.com", pending: true }),
  oldApp: op({ kind: "access-app", key: "gone.example.com", action: "delete", before: { name: "infra-sync: web gone.example.com" }, after: null, reason: "no droplet file serves this site any more" }),
  infraApp: op({ kind: "infra-app", key: "infra-sync: SSH targets", action: "update", before: { emails: ["a@example.com"] }, after: { emails: ["a@example.com", "b@example.com"] }, reason: "ssh admins changed" }),
  ssh: op({ provider: "github", module: "sshconfig", kind: "ssh-config", key: "example-org/infra@ssh-config:ssh_config", action: "update", before: { hosts: 3 }, after: { hosts: 4, added: ["new.example.com"], removed: [] }, reason: "the ssh config is out of date (1 added)", ids: { content: "Host SECRET-CONFIG-TEXT\n", readme: "README-TEXT" } }),
  fw: op({ provider: "digitalocean", module: "firewall", kind: "firewall-rule", key: "fw-db inbound tcp/5432 10.0.0.11/32", action: "report", after: { from: "shop.example.com" }, reason: "allow.droplet from shop.example.com", droplet: "db.example.com" }),
  frozen: op({ provider: "digitalocean", module: "droplets", kind: "droplet-tags", key: "data.example.com", action: "report", before: { tags: [] }, after: { tags: ["env-prod"] }, reason: "frozen droplet, would update: tags differ", droplet: "data.example.com" }),
  monitorKept: op({ provider: "oneuptime", module: "oneuptime", kind: "monitor", key: "old.example.com/", action: "report", reason: "owned monitor with no droplet file; never deleted" }),
};

const plan = (module: ModulePlan["module"], ops: PlanOp[], unchanged = 0, diagnostics: ModulePlan["diagnostics"] = []): ModulePlan => ({ module, ops, unchanged, diagnostics });

/** A check run with changes of every kind, a warning, report ops and an unmanaged droplet. */
export function checkReport(over: Partial<RunReport> = {}): RunReport {
  const r = newReport("check", new Date("2026-11-19T04:00:00Z"), "0123456789abcdef0123456789abcdef01234567");
  r.dropletFiles = 6;
  r.stages = [
    { stage: "load", status: "ok" },
    { stage: "observe cloudflare", status: "ok" },
  ];
  r.diagnostics = [{ level: "warning", code: "cross-region", file: "droplets/db.example.com.yaml", line: 7, path: "allow.droplet[0].from", droplet: "db.example.com", message: "caller in another region: rule uses its public IP" }];
  r.plans = [
    plan("droplets", [OPS.newDroplet, OPS.frozen], 4),
    plan("cloudflare", [OPS.vpc, OPS.route, OPS.newDns, OPS.oldApp, OPS.infraApp], 30, [{ level: "info", code: "note", message: "2 targets already exist" }]),
    plan("firewall", [OPS.fw]),
    plan("oneuptime", [OPS.monitorKept], 5),
    plan("sshconfig", [OPS.ssh]),
  ];
  r.unmanaged = [{ id: 77, name: "build-box", region: "nyc1" }];
  r.credentials = [{ name: "INFRA_GH_TOKEN", expiresAt: "2027-06-01T00:00:00.000Z" }];
  return { ...r, ...over };
}

/** An apply that did everything but one Cloudflare op. */
export function applyReport(over: Partial<RunReport> = {}): RunReport {
  const r = checkReport({ mode: "apply" });
  r.applied = [
    { module: "droplets", applied: [OPS.newDroplet], failed: [], skipped: [{ op: OPS.frozen, reason: "report-only" }] },
    { module: "cloudflare", applied: [OPS.vpc, OPS.route, OPS.infraApp], failed: [{ op: OPS.oldApp, error: "cloudflare DELETE /accounts/x/access/apps/y: HTTP 500" }], skipped: [{ op: OPS.newDns, reason: "waiting for a droplet that isn't up yet" }] },
    { module: "firewall", applied: [], failed: [], skipped: [{ op: OPS.fw, reason: "report-only" }] },
    { module: "sshconfig", applied: [OPS.ssh], failed: [], skipped: [] },
  ];
  r.stages.push({ stage: "apply cloudflare", status: "ok" });
  return { ...r, ...over };
}

export function driftReport(over: Partial<RunReport> = {}): RunReport {
  const r = checkReport({ mode: "drift" });
  r.credentials = [{ name: "INFRA_GH_TOKEN", expiresAt: "2026-12-01T10:00:00.000Z" }];
  return { ...r, ...over };
}

/** A clean run: nothing to change, nothing unmanaged. */
export function cleanReport(mode: RunReport["mode"]): RunReport {
  const r = newReport(mode, new Date("2026-11-19T04:00:00Z"));
  r.dropletFiles = 3;
  r.stages = [{ stage: "load", status: "ok" }];
  r.plans = [plan("cloudflare", [], 12), plan("sshconfig", [], 1)];
  r.credentials = [{ name: "INFRA_GH_TOKEN", expiresAt: "2027-06-01T00:00:00.000Z" }];
  return r;
}

/** Droplets were created, then re-planning failed: the engine stopped part-way. */
export function stoppedReport(): RunReport {
  const r = checkReport({ mode: "apply", diagnostics: [] });
  r.applied = [{ module: "droplets", applied: [OPS.newDroplet], failed: [], skipped: [] }];
  r.stages.push({ stage: "apply droplets", status: "ok" }, { stage: "apply", status: "skipped", error: "re-planning after droplet changes failed; nothing else applied" });
  return r;
}
