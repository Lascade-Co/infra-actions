// The renderers fed with reports the engine really produced (not hand-built fixtures): an apply
// stopped by a module that threw part-way must never read "nothing was applied".

import { describe, expect, it } from "vitest";
import { runEngine } from "../../src/engine.js";
import { renderApplySummary, renderTelegram } from "../../src/output/index.js";
import { fakeModules, type FakeOptions } from "../fakes.js";
import { EXAMPLE_DIR, observedDroplet } from "../helpers.js";

const EXISTING = [
  observedDroplet("shop.example.com", { id: 1, privateIpv4: "10.0.0.11" }),
  observedDroplet("db.example.com", { id: 2, privateIpv4: "10.0.0.12" }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13" }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14" }),
];

async function applyWith(fake: Partial<FakeOptions>) {
  const f = fakeModules({ droplets: EXISTING, ...fake });
  return runEngine({
    mode: "apply",
    infraDir: EXAMPLE_DIR,
    env: {},
    fetch: async () => {
      throw new Error("no network in tests");
    },
    modules: f.modules,
    now: () => new Date("2026-11-19T00:00:00Z"),
    sleep: async () => {},
  });
}

describe("rendering engine-produced apply reports", () => {
  it("a module that threw reads as stopped part-way, with the rest listed as not applied", async () => {
    const report = await applyWith({ failApply: { droplets: new Error("HTTP 503") } });
    const md = renderApplySummary(report);
    expect(md.split("\n")[0]).toBe("## infra apply: ❌ stopped part-way");
    expect(md).toContain("**Stopped part-way:** applying droplets failed; nothing after it was applied.");
    expect(md).toContain("### Planned, not applied");
    expect(md).not.toContain("Nothing was applied");
    const tg = renderTelegram(report).join("\n");
    expect(tg).toContain("Stopped part-way");
    expect(tg).not.toContain("Nothing applied");
  });

  it("a failed op stops the run part-way after the modules before it", async () => {
    const report = await applyWith({ failApply: { cloudflare: "op" } });
    const md = renderApplySummary(report);
    expect(md.split("\n")[0]).toBe("## infra apply: ❌ stopped part-way");
    expect(md).toContain("applying cloudflare failed; nothing after it was applied");
    expect(md).toContain("### Applied (");
  });

  it("an apply blocked before writing anything says so", async () => {
    const report = await applyWith({ checkErrors: [{ level: "error", code: "x", message: "bad reference" }] });
    expect(renderApplySummary(report).split("\n")[0]).toBe("## infra apply: ⛔ blocked: nothing was applied");
    expect(renderTelegram(report).join("\n")).toContain("Nothing applied");
  });
});
