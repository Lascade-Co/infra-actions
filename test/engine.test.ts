import { describe, expect, it } from "vitest";
import { KNOWN_AFTER_CREATE } from "../src/core/constants.js";
import { reportPassed } from "../src/core/report.js";
import type { ModulePlan, PlanOp } from "../src/core/plan.js";
import { freezeOps, runEngine, type EngineOptions } from "../src/engine.js";
import { renderLogLine } from "../src/output/index.js";
import { fakeModules, type FakeOptions } from "./fakes.js";
import { EXAMPLE_DIR, observedDroplet } from "./helpers.js";

const EXISTING = [
  observedDroplet("shop.example.com", { id: 1, privateIpv4: "10.0.0.11" }),
  observedDroplet("db.example.com", { id: 2, privateIpv4: "10.0.0.12" }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13" }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14" }),
  observedDroplet("build-box", { id: 5 }),
];

const noFetch: EngineOptions["fetch"] = async () => {
  throw new Error("tests make no network calls");
};

async function run(mode: EngineOptions["mode"], fake: Partial<FakeOptions> = {}, env: Record<string, string> = {}) {
  const f = fakeModules({ droplets: EXISTING, ...fake });
  const report = await runEngine({
    mode,
    infraDir: EXAMPLE_DIR,
    env,
    fetch: noFetch,
    modules: f.modules,
    now: () => new Date("2026-11-19T00:00:00Z"),
    sleep: async () => {},
  });
  return { report, ...f };
}

describe("engine: check", () => {
  it("plans every module read-only and records stages, unmanaged droplets and credentials", async () => {
    const { report, calls, contexts } = await run("check");
    expect(contexts[0]!.allowWrites).toBe(false);
    expect(calls).toEqual(["checks", "observe droplets", "plan droplets", "observe cloudflare", "plan cloudflare"]);
    expect(report.stages.every((s) => s.status === "ok")).toBe(true);
    expect(report.dropletFiles).toBe(6);
    expect(report.unmanaged).toEqual([{ id: 5, name: "build-box", region: "nyc1" }]);
    expect(report.credentials).toEqual([{ name: "INFRA_GH_TOKEN", expiresAt: "2027-01-01" }]);
    expect(report.plans.map((p) => [p.module, p.ops.length])).toEqual([
      ["droplets", 2],
      ["cloudflare", 6],
      ["firewall", 1],
      ["sshconfig", 0],
    ]);
    expect(reportPassed(report)).toBe(true);
  });

  it("shows values of droplets still to be created as known after create", async () => {
    const { report } = await run("check");
    const cf = report.plans.find((p) => p.module === "cloudflare")!;
    const pending = cf.ops.filter((o) => o.pending).map((o) => o.droplet);
    expect(pending).toEqual(["staging-shop.example.com", "worker-2.example.com"]);
    expect(cf.ops.find((o) => o.pending)!.after).toEqual({ content: KNOWN_AFTER_CREATE });
  });

  it("turns a frozen droplet's changes into report ops", async () => {
    const { report } = await run("check");
    const db = report.plans.flatMap((p) => p.ops).filter((o) => o.droplet === "db.example.com");
    expect(db.map((o) => o.action)).toEqual(["report", "report"]);
    expect(db[0]!.reason).toMatch(/^frozen droplet, would create: /);
  });

  it("fails when a module isn't implemented or a read fails, and keeps going", async () => {
    const e = Object.assign(new Error("cloudflare GET /zones: HTTP 403"), { name: "ApiError" });
    const { report } = await run("check", { failObserve: { cloudflare: e } });
    expect(report.stages.find((s) => s.stage === "observe cloudflare")).toMatchObject({ status: "failed", error: "ApiError: cloudflare GET /zones: HTTP 403" });
    expect(report.stages.find((s) => s.stage === "plan cloudflare")).toMatchObject({ status: "skipped" });
    expect(report.plans.map((p) => p.module)).toEqual(["droplets", "firewall", "sshconfig"]);
    expect(reportPassed(report)).toBe(false);
  });

  it("redacts secret values from stage errors", async () => {
    const token = "super-secret-token-value";
    const e = new Error(`echoed ${token}`);
    const { report } = await run("check", { failObserve: { cloudflare: e } }, { CF_API_TOKEN: token });
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("stops after load when the checkout is invalid (validate mode never reaches modules)", async () => {
    const { report, calls } = await run("validate");
    expect(calls).toEqual([]);
    expect(report.stages).toEqual([{ stage: "load", status: "ok" }]);
  });
});

describe("engine: apply", () => {
  it("applies droplets first, re-plans with the new IPs, then applies the rest in order", async () => {
    const { report, calls, contexts, telegram } = await run("apply", {}, { TELEGRAM_BOT_TOKEN: "x-telegram-token" });
    expect(contexts[0]!.allowWrites).toBe(true);
    expect(calls).toEqual([
      "checks",
      "observe droplets",
      "plan droplets",
      "observe cloudflare",
      "plan cloudflare",
      "apply droplets 2",
      "observe droplets",
      "plan droplets",
      "observe cloudflare",
      "plan cloudflare",
      // db.example.com is frozen: its op is a report op, so 5 of 6
      "apply cloudflare 5",
      "apply firewall 0",
      "apply sshconfig 0",
    ]);
    const cf = report.applied.find((a) => a.module === "cloudflare")!;
    expect(cf.applied.every((o) => !o.pending)).toBe(true);
    expect(report.applied.find((a) => a.module === "droplets")!.applied.map((o) => o.key)).toEqual([
      "staging-shop.example.com",
      "worker-2.example.com",
    ]);
    expect(telegram).toEqual([["summary"]]);
    expect(reportPassed(report)).toBe(true);
  });

  it("applies nothing when a check fails", async () => {
    const { report, calls } = await run("apply", { checkErrors: [{ level: "error", code: "x", message: "bad reference" }] });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.stages.find((s) => s.stage === "apply")).toMatchObject({ status: "skipped" });
    expect(report.applied).toEqual([]);
  });

  it("still sends the Telegram summary when apply is blocked", async () => {
    const { report, telegram } = await run(
      "apply",
      { checkErrors: [{ level: "error", code: "x", message: "bad reference" }] },
      { TELEGRAM_BOT_TOKEN: "x-telegram-token" },
    );
    expect(report.applied).toEqual([]);
    expect(telegram).toEqual([["summary"]]);
    expect(report.stages.at(-1)).toEqual({ stage: "notify telegram", status: "ok" });
  });

  it("still sends the Telegram summary when the droplets can't be read", async () => {
    const { telegram } = await run("apply", { failObserve: { droplets: new Error("timeout") } }, { TELEGRAM_BOT_TOKEN: "x-telegram-token" });
    expect(telegram).toEqual([["summary"]]);
  });

  it("applies nothing when any stage failed", async () => {
    const { calls } = await run("apply", { failObserve: { cloudflare: new Error("timeout") } });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
  });

  it("applies nothing when checkDesired finds an error", async () => {
    const { report, calls } = await run("apply", { desiredDiagnostics: () => [{ level: "error", code: "swarm-region", message: "members in two regions" }] });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.stages.find((s) => s.stage === "apply")).toMatchObject({ status: "skipped", error: "the plan has errors or failed stages; nothing applied" });
  });

  it("applies nothing when a module's plan has an error diagnostic", async () => {
    const { report, calls } = await run("apply", { cloudflareDiagnostics: [{ level: "error", code: "cloudflare-dependent", message: "a DNS-only record depends on it" }] });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.applied).toEqual([]);
    expect(reportPassed(report)).toBe(false);
  });

  const applyStages = (r: Awaited<ReturnType<typeof run>>["report"]) =>
    r.stages.filter((s) => s.stage.startsWith("apply")).map((s) => [s.stage, s.status]);

  it("stops after a droplets apply failure: later modules are skipped and reported as skipped", async () => {
    const { report, calls } = await run("apply", { failApply: { droplets: "op" } }, { TELEGRAM_BOT_TOKEN: "x-telegram-token" });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual(["apply droplets 2"]);
    // No re-plan either.
    expect(calls.filter((c) => c === "observe droplets")).toHaveLength(1);
    expect(applyStages(report)).toEqual([
      ["apply droplets", "ok"],
      ["apply", "skipped"],
      ["apply cloudflare", "skipped"],
      ["apply firewall", "skipped"],
      ["apply sshconfig", "skipped"],
    ]);
    expect(report.stages.find((s) => s.stage === "apply")!.error).toBe("applying droplets failed; nothing after it was applied");
    expect(report.applied.map((a) => a.module)).toEqual(["droplets"]);
    expect(reportPassed(report)).toBe(false);
    expect(report.stages.at(-1)).toEqual({ stage: "notify telegram", status: "ok" });
  });

  it("stops when the droplets apply throws", async () => {
    const { report, calls } = await run("apply", { failApply: { droplets: new Error("HTTP 503") } });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual(["apply droplets 2"]);
    expect(applyStages(report)).toEqual([
      ["apply droplets", "failed"],
      ["apply", "skipped"],
      ["apply cloudflare", "skipped"],
      ["apply firewall", "skipped"],
      ["apply sshconfig", "skipped"],
    ]);
    expect(report.applied).toEqual([]);
  });

  it("stops at the first failing module after droplets, skipping the ones after it", async () => {
    const { report, calls } = await run("apply", { failApply: { cloudflare: "op" } });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual(["apply droplets 2", "apply cloudflare 5"]);
    expect(applyStages(report)).toEqual([
      ["apply droplets", "ok"],
      ["apply cloudflare", "ok"],
      ["apply", "skipped"],
      ["apply firewall", "skipped"],
      ["apply sshconfig", "skipped"],
    ]);
    expect(report.stages.find((s) => s.stage === "apply")!.error).toBe("applying cloudflare failed; nothing after it was applied");
    expect(reportPassed(report)).toBe(false);
  });

  it("stops after creating droplets when the plan made again has an error", async () => {
    const { report, calls } = await run("apply", {
      desiredDiagnostics: (n) => (n === 1 ? [] : [{ level: "error", code: "swarm-region", message: "new member landed in another region" }]),
    });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual(["apply droplets 2"]);
    expect(calls.filter((c) => c === "observe droplets")).toHaveLength(2);
    expect(report.stages.find((s) => s.stage === "apply")).toMatchObject({
      status: "skipped",
      error: "the plan made again after the droplet changes has errors or failed stages; nothing else applied",
    });
    expect(report.diagnostics.map((d) => d.code)).toContain("swarm-region");
    expect(reportPassed(report)).toBe(false);
  });

  it("stops after creating droplets when a read fails in the plan made again", async () => {
    let cfObserves = 0;
    const f = fakeModules({ droplets: EXISTING });
    const report = await runEngine({
      mode: "apply",
      infraDir: EXAMPLE_DIR,
      env: {},
      fetch: noFetch,
      modules: (ctx) => {
        const m = f.modules(ctx);
        const cf = m.providers[0]!;
        m.providers[0] = {
          ...cf,
          module: cf.module,
          observe: async (d) => {
            if (++cfObserves === 2) throw new Error("timeout");
            return cf.observe(d);
          },
          diff: cf.diff,
          apply: cf.apply,
        };
        return m;
      },
      now: () => new Date("2026-11-19T00:00:00Z"),
      sleep: async () => {},
    });
    expect(f.calls.filter((c) => c.startsWith("apply"))).toEqual(["apply droplets 2"]);
    expect(report.stages.find((s) => s.stage === "apply")!.error).toMatch(/^the plan made again/);
  });

  it("never applies in drift mode, and sends the drift summary to Telegram", async () => {
    const { report, calls, contexts, telegram } = await run("drift", {}, { TELEGRAM_BOT_TOKEN: "x-telegram-token" });
    expect(contexts[0]!.allowWrites).toBe(false);
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.unmanaged).toHaveLength(1);
    expect(telegram).toEqual([["summary"]]);
  });

  it("never sends Telegram for check (its output is the PR comment)", async () => {
    const { telegram, report } = await run("check", {}, { TELEGRAM_BOT_TOKEN: "x-telegram-token" });
    expect(telegram).toEqual([]);
    expect(report.stages.some((s) => s.stage === "notify telegram")).toBe(false);
  });
});

describe("engine: real registry without credentials", () => {
  it("fails the read-only run safely instead of crashing, and the log line has counts only", async () => {
    const report = await runEngine({ mode: "check", infraDir: EXAMPLE_DIR, env: {}, fetch: noFetch });
    expect(report.stages.find((s) => s.stage === "observe droplets")?.status).toBe("failed");
    expect(reportPassed(report)).toBe(false);
    expect(renderLogLine(report)).toMatch(/^infra check: FAIL \| droplet files 6 \| /);
  });
});

describe("freezeOps: the SSH access exception (option b)", () => {
  const op = (over: Partial<PlanOp> & Pick<PlanOp, "kind" | "key">): PlanOp => ({
    provider: "cloudflare",
    module: "cloudflare",
    action: "update",
    before: {},
    after: {},
    reason: "r",
    droplet: "db.example.com",
    ...over,
  });
  const frozen = new Set(["db.example.com"]);
  const plan = (ops: PlanOp[]): ModulePlan => ({ module: "cloudflare", ops, unchanged: 0, diagnostics: [] });

  it("applies a frozen droplet's SSH access updates and freezes everything else", () => {
    const out = freezeOps(
      plan([
        op({ kind: "infra-target", key: "db.example.com", appliesWhenFrozen: true }),
        op({ kind: "access-app", key: "ssh-db.example.com", appliesWhenFrozen: true }),
        op({ kind: "access-app", key: "db.example.com/healthcheck" }),
        op({ kind: "dns-record", key: "A vpc-db.example.com", appliesWhenFrozen: true }),
        op({ kind: "infra-target", key: "db.example.com (new)", action: "create", appliesWhenFrozen: true }),
        op({ provider: "digitalocean", module: "droplets", kind: "droplet-tags", key: "db.example.com", appliesWhenFrozen: true }),
        op({ kind: "infra-target", key: "other.example.com", droplet: "other.example.com" }),
      ]),
      frozen,
    ).ops;
    expect(out.map((o) => [o.key, o.action])).toEqual([
      ["db.example.com", "update"],
      ["ssh-db.example.com", "update"],
      ["db.example.com/healthcheck", "report"],
      ["A vpc-db.example.com", "report"],
      ["db.example.com (new)", "report"],
      ["db.example.com", "report"],
      ["other.example.com", "update"],
    ]);
    expect(out[0]!.reason).toBe("frozen: only SSH access changes are applied: r");
    expect(out[2]!.reason).toBe("frozen droplet, would update: r");
  });
});
