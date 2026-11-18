// The engine runs checkChange after observing the droplets, so a removed file can be checked
// against DigitalOcean (decision 15), and still runs it (failing safe) when that read fails.

import { cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkChange } from "../../src/checks/index.js";
import { reportPassed } from "../../src/core/report.js";
import { runEngine } from "../../src/engine.js";
import { fakeModules, type FakeOptions } from "../fakes.js";
import { EXAMPLE_DIR, observedDroplet, tempDir } from "../helpers.js";

const EXISTING = [
  observedDroplet("shop.example.com", { id: 1 }),
  observedDroplet("db.example.com", { id: 2 }),
  observedDroplet("worker.example.com", { id: 3 }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1" }),
];

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function runWithRemovedTools(fake: Partial<FakeOptions>, mode: "check" | "apply" = "check") {
  const t = await tempDir();
  cleanup = t.cleanup;
  const head = join(t.dir, "infra");
  await cp(EXAMPLE_DIR, head, { recursive: true });
  await rm(join(head, "droplets", "tools.example.net.yaml"));
  const f = fakeModules({ droplets: EXISTING, ...fake });
  const report = await runEngine({
    mode,
    infraDir: head,
    baseDir: EXAMPLE_DIR,
    env: {},
    fetch: async () => {
      throw new Error("no network in tests");
    },
    modules: (ctx) => {
      const m = f.modules(ctx);
      return { ...m, checks: { ...m.checks, checkChange } };
    },
    now: () => new Date("2026-11-19T00:00:00Z"),
    sleep: async () => {},
  });
  return Object.assign(report, { calls: f.calls });
}

describe("engine wiring of checkChange", () => {
  it("fails check when a removed file's droplet still exists", async () => {
    const report = await runWithRemovedTools({});
    expect(report.stages.map((s) => s.stage)).toContain("checks against base");
    expect(report.diagnostics.filter((d) => d.code.startsWith("removed-")).map((d) => [d.code, d.droplet])).toEqual([["removed-droplet-exists", "tools.example.net"]]);
    expect(report.diagnostics.some((d) => d.level === "error")).toBe(true);
    expect(reportPassed(report)).toBe(false);
  });

  it("passes once the droplet is gone, with a warning", async () => {
    const report = await runWithRemovedTools({ droplets: EXISTING.filter((d) => d.name !== "tools.example.net") });
    expect(report.diagnostics.map((d) => d.code)).toContain("droplet-file-removed");
    expect(report.diagnostics.some((d) => d.level === "error")).toBe(false);
  });

  it("stops apply --base too: nothing is written while a removed file's droplet still exists", async () => {
    const report = await runWithRemovedTools({}, "apply");
    expect(report.diagnostics.map((d) => d.code)).toContain("removed-droplet-exists");
    expect(report.calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    expect(report.stages.find((s) => s.stage === "apply")).toMatchObject({ status: "skipped" });
    expect(report.applied).toEqual([]);
  });

  it("still runs, failing safe, when the droplets can't be read", async () => {
    const report = await runWithRemovedTools({ failObserve: { droplets: new Error("read failed") } });
    expect(report.diagnostics.map((d) => d.code)).toContain("removed-droplet-unverified");
  });
});
