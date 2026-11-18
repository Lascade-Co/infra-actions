import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import type { PlanOp, RunContext } from "../src/core/plan.js";
import { validate } from "../src/core/schema.js";
import { Secrets } from "../src/core/secrets.js";
import { applyFirewall } from "../src/firewall/index.js";
import { createModules } from "../src/registry.js";
import { loadInfraFiles } from "../src/core/loader.js";
import { exampleFiles } from "./helpers.js";

const op = (action: PlanOp["action"]): PlanOp => ({
  provider: "digitalocean",
  module: "firewall",
  kind: "firewall-rule",
  key: "fw-x inbound tcp/22 192.0.2.1/32",
  action,
  before: null,
  after: {},
  reason: "test",
});

describe("contracts", () => {
  it("firewall apply is report-only: skips report ops, refuses anything else", async () => {
    expect(await applyFirewall([op("report")])).toEqual({ module: "firewall", applied: [], failed: [], skipped: [{ op: op("report"), reason: "report-only" }] });
    await expect(applyFirewall([op("report"), op("create")])).rejects.toThrow("report-only until migration Phase 5");
  });

  it("the registry plans and applies in the documented order", async () => {
    const config = loadInfraFiles(await exampleFiles()).config!;
    const ctx: RunContext = {
      mode: "check",
      account: config.account,
      secrets: new Secrets({}),
      fetch: async () => {
        throw new Error("no network");
      },
      allowWrites: false,
      now: () => new Date(0),
      sleep: async () => {},
    };
    const m = createModules(ctx);
    expect(m.droplets.module).toBe("droplets");
    expect(m.providers.map((p) => p.module)).toEqual(["cloudflare", "firewall", "oneuptime", "sshconfig"]);
  });

  it("the droplet file example in README.md is valid", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const block = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.startsWith("name: "));
    expect(block).toBeDefined();
    expect(validate("droplet", parse(block!))).toEqual([]);
  });
});
