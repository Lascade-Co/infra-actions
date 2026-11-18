import { describe, expect, it } from "vitest";
import { KNOWN_AFTER_CREATE } from "../src/core/constants.js";
import { reportPassed } from "../src/core/report.js";
import { runEngine, type EngineOptions } from "../src/engine.js";
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

  it("applies nothing when any stage failed", async () => {
    const { calls } = await run("apply", { failObserve: { cloudflare: new Error("timeout") } });
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
  });

  it("never applies in drift mode", async () => {
    const { report, calls, contexts } = await run("drift");
    expect(contexts[0]!.allowWrites).toBe(false);
    expect(calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.unmanaged).toHaveLength(1);
  });
});

describe("engine: real registry before B1-B7", () => {
  it("reports unimplemented stages instead of crashing, and the log line has counts only", async () => {
    const report = await runEngine({ mode: "check", infraDir: EXAMPLE_DIR, env: {}, fetch: noFetch });
    expect(report.stages.map((s) => s.status)).toContain("not-implemented");
    expect(reportPassed(report)).toBe(false);
    expect(renderLogLine(report)).toMatch(/^infra check: FAIL \| droplet files 6 \| /);
  });
});
