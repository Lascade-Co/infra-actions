// The example checkout through the real loader: plan, apply, and a second plan with no changes.

import { describe, expect, it } from "vitest";
import { applyCloudflare, observeCloudflare, planCloudflare } from "../../src/cloudflare/index.js";
import { buildDesired } from "../../src/core/desired.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import { isChange } from "../../src/core/plan.js";
import { freezeOps } from "../../src/engine.js";
import { exampleFiles, observedDroplet } from "../helpers.js";
import { FakeCloudflare, testContext } from "./fake.js";

describe("the example checkout", () => {
  it("plans and applies through the loader; the second plan only has pending, frozen and not-built ops", async () => {
    const config = loadInfraFiles(await exampleFiles()).config!;
    const cf = config.account.cloudflare;
    const f = new FakeCloudflare();
    f.zones = [
      { id: "zone-com", name: "example.com" },
      { id: "zone-net", name: "example.net" },
    ];
    f.dns = { "zone-com": [], "zone-net": [] };
    f.tunnels = {};
    for (const t of Object.values(cf.tunnels)) f.tunnels[t] = { tunnel_id: t, source: "cloudflare", version: 1, config: { ingress: [{ service: "http_status:404" }] } };
    const observed = [
      observedDroplet("db.example.com", { id: 1, privateIpv4: "10.0.0.11", publicIpv4: "203.0.113.11" }),
      observedDroplet("shop.example.com", { id: 2, privateIpv4: "10.0.0.12", publicIpv4: "203.0.113.12" }),
      observedDroplet("tools.example.net", { id: 3, region: "blr1", privateIpv4: "10.0.1.13", publicIpv4: "203.0.113.13" }),
      observedDroplet("worker.example.com", { id: 4, privateIpv4: "10.0.0.14", publicIpv4: "203.0.113.14" }),
    ];
    const desired = buildDesired(config, observed);
    const frozen = new Set(desired.droplets.filter((d) => d.frozen).map((d) => d.name));
    const ctx = testContext(f, config.account);

    const plan1 = freezeOps(planCloudflare(desired, await observeCloudflare(ctx)), frozen);
    expect(plan1.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    const res = await applyCloudflare(ctx, plan1.ops.filter((o) => isChange(o) && !o.pending), await observeCloudflare(ctx));
    expect(res.failed).toEqual([]);
    expect(f.apps.some((a) => a.domain === "tools.example.net/api")).toBe(true);
    expect(f.apps.some((a) => a.domain === "db-etl.example.com")).toBe(false); // db is frozen

    const plan2 = freezeOps(planCloudflare(desired, await observeCloudflare(ctx)), frozen);
    const left = plan2.ops.filter((o) => isChange(o) && !o.pending);
    expect(left).toEqual([]);
    const reports = plan2.ops.filter((o) => o.action === "report");
    expect(reports.every((o) => o.droplet === "db.example.com" || o.key.startsWith("(not built)"))).toBe(true);
    expect(plan2.ops.filter((o) => o.pending).every((o) => o.droplet === "staging-shop.example.com" || o.droplet === "worker-2.example.com")).toBe(true);
  });
});
