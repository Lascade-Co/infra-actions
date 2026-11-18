// What the tool adds to the Worker's behaviour: allow.tunnel routes, service-token exceptions,
// the zone check, frozen and new droplets, report ops for blocked deletes, apply from ops alone.

import { describe, expect, it } from "vitest";
import { applyCloudflare, createCloudflareProvider, observeCloudflare, planCloudflare } from "../../src/cloudflare/index.js";
import { KNOWN_AFTER_CREATE } from "../../src/core/constants.js";
import { WriteNotAllowedError } from "../../src/core/http.js";
import { isChange } from "../../src/core/plan.js";
import {
  changes,
  desiredFor,
  droplet,
  ETL_TOKEN,
  exampleFixture,
  FakeCloudflare,
  isAppPost,
  isDnsPost,
  isTunnelPutWith,
  opKeys,
  planOnly,
  run,
  STAFF_POLICY,
  T_BLR1,
  T_NYC1,
  testAccount,
  testContext,
  UPTIME_TOKEN,
  Z_COM,
  Z_NET,
} from "./fake.js";

function withDb(): FakeCloudflare {
  const f = new FakeCloudflare();
  f.droplets = [droplet(10, "db.example.com", "nyc1", "10.0.0.20", ["env-prod"])];
  f.routes["db.example.com"] = [{ route: "db-etl.example.com", port: "5432/tcp", who: ["service-token:etl", "staff"] }];
  return f;
}

describe("allow.tunnel routes", () => {
  it("creates the Access app, then the tcp route, then the CNAME; a second plan has no changes", async () => {
    const f = withDb();
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    const w = f.writes();
    const a = w.findIndex(isAppPost("db-etl.example.com"));
    const i = w.findIndex(isTunnelPutWith(T_NYC1, "db-etl.example.com"));
    const d = w.findIndex(isDnsPost("db-etl.example.com"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(i);
    expect(i).toBeLessThan(d);

    const app = f.apps.find((x) => x.domain === "db-etl.example.com")!;
    expect(app.name).toBe("infra-sync: tunnel db-etl.example.com");
    expect(app.allow_authenticate_via_warp).toBe(true);
    // Service Auth for the etl token first, then the reusable staff policy (expanded by the API).
    expect(app.policies?.[0]).toMatchObject({ decision: "non_identity", include: [{ service_token: { token_id: ETL_TOKEN } }], precedence: 1 });
    expect(app.policies?.[1]).toMatchObject({ id: STAFF_POLICY, reusable: true, precedence: 2 });
    expect(f.tunnels[T_NYC1]!.config!.ingress).toContainEqual({ hostname: "db-etl.example.com", service: "tcp://10.0.0.20:5432" });
    expect(f.dns[Z_COM]!.find((x) => x.name === "db-etl.example.com")).toMatchObject({ type: "CNAME", content: `${T_NYC1}.cfargotunnel.com`, proxied: true, comment: "managed-by:infra-sync" });

    expect(changes(await planOnly(f))).toEqual([]);
  });

  it("is not mistaken for an ssh- app or a site: its objects stay while the file declares the route", async () => {
    const f = withDb();
    await run(f);
    const p = await planOnly(f);
    expect(p.ops.filter((o) => o.action === "delete" || o.action === "report")).toEqual([]);
  });

  it("updates the app in place when `who` changes (staff only: the token policy goes)", async () => {
    const f = withDb();
    await run(f);
    const id = f.apps.find((x) => x.domain === "db-etl.example.com")!.id;
    f.routes["db.example.com"] = [{ route: "db-etl.example.com", port: "5432/tcp", who: ["staff"] }];
    const r = await run(f);
    expect(opKeys(r.plan).filter((k) => !k.startsWith("report"))).toEqual(["update access-app db-etl.example.com"]);
    const app = f.apps.find((x) => x.domain === "db-etl.example.com")!;
    expect(app.id).toBe(id);
    expect(app.policies).toHaveLength(1);
    expect(app.policies?.[0]).toMatchObject({ id: STAFF_POLICY });
    expect(changes(await planOnly(f))).toEqual([]);
  });

  it("a removed route goes: CNAME, then the route, then the app", async () => {
    const f = withDb();
    await run(f);
    f.routes = {};
    const before = f.calls.length;
    const r = await run(f);
    expect(r.result.failed).toEqual([]);
    const w = f.calls.slice(before).filter((c) => c.method !== "GET");
    expect(w.map((c) => `${c.method} ${c.path.split("/").slice(-2).join("/")}`)).toEqual([
      expect.stringMatching(/^DELETE dns_records\//),
      `PUT ${T_NYC1}/configurations`,
      expect.stringMatching(/^DELETE apps\//),
    ]);
    expect(f.apps.some((a) => a.domain === "db-etl.example.com")).toBe(false);
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "db-etl.example.com")).toBe(false);
  });

  it("UDP and port ranges are shown as report ops with a warning, never built", async () => {
    const f = withDb();
    f.routes["db.example.com"] = [
      { route: "metrics.example.com", port: "9100/udp", who: ["staff"] },
      { route: "range.example.com", port: "8000-8010/tcp", who: ["staff"] },
    ];
    const r = await run(f);
    expect(r.plan.ops.filter((o) => o.key.startsWith("(not built)")).map((o) => o.action)).toEqual(["report", "report"]);
    expect(r.plan.diagnostics.filter((d) => d.code === "cloudflare-route-not-built")).toHaveLength(2);
    expect(f.apps.some((a) => /metrics|range/.test(a.domain ?? ""))).toBe(false);
  });

  it("never takes a name another record, app or rule holds", async () => {
    const f = withDb();
    f.dns[Z_COM]!.push({ id: "manual-1", name: "db-etl.example.com", type: "A", content: "192.0.2.50", proxied: false });
    const r = await run(f);
    expect(r.plan.diagnostics.some((d) => d.code === "cloudflare-conflict" && /db-etl\.example\.com/.test(d.message))).toBe(true);
    expect(f.apps.some((a) => a.domain === "db-etl.example.com")).toBe(false);
    expect(f.dns[Z_COM]!.find((x) => x.name === "db-etl.example.com")!.id).toBe("manual-1");
  });

  it("fail closed: if the app can't be created, no route and no CNAME", async () => {
    const f = withDb();
    f.failWhen((c) => (isAppPost("db-etl.example.com")(c) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(r.result.failed.map((x) => x.op.key)).toEqual(["db-etl.example.com"]);
    expect(r.result.skipped.map((x) => x.op.key)).toEqual(expect.arrayContaining([`${T_NYC1} db-etl.example.com`, "CNAME db-etl.example.com"]));
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "db-etl.example.com")).toBe(false);
    expect(f.dns[Z_COM]!.some((x) => x.name === "db-etl.example.com")).toBe(false);
  });

  it("a route whose app was deleted out-of-band is removed if the app can't be recreated", async () => {
    const f = withDb();
    await run(f);
    f.apps = f.apps.filter((a) => a.domain !== "db-etl.example.com");
    f.failWhen((c) => (isAppPost("db-etl.example.com")(c) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(r.result.applied.some((o) => o.action === "delete" && o.key === `${T_NYC1} db-etl.example.com`)).toBe(true);
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "db-etl.example.com")).toBe(false);
  });

  it("moves with its droplet to another region's tunnel: new route first, then the old one goes", async () => {
    const f = withDb();
    await run(f);
    f.droplets[0] = { ...f.droplets[0]!, region: "blr1", privateIp: "10.0.1.20" };
    const r = await run(f);
    expect(r.result.failed).toEqual([]);
    expect(f.tunnels[T_BLR1]!.config!.ingress).toContainEqual({ hostname: "db-etl.example.com", service: "tcp://10.0.1.20:5432" });
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "db-etl.example.com")).toBe(false);
    expect(f.dns[Z_COM]!.find((x) => x.name === "db-etl.example.com")!.content).toBe(`${T_BLR1}.cfargotunnel.com`);
    expect(changes(await planOnly(f))).toEqual([]);
  });
});

describe("exceptions with service tokens", () => {
  it("Service Auth next to the ips Bypass; ips-only and everyone keep the Worker's single Bypass policy", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(11, "shop.example.com", "nyc1", "10.0.0.30", ["env-prod", "web-public"])];
    f.sites["shop.example.com"] = {
      exceptions: [
        { path: "/api/partner", allow: { ips: ["198.51.100.0/24"], service_tokens: ["uptime"] } },
        { path: "/api/monitor", allow: { service_tokens: ["uptime"] } },
        { path: "/webhooks", allow: { ips: ["203.0.113.9/32"] } },
        { path: "/hooks", allow: "everyone" },
      ],
    };
    const r = await run(f);
    expect(r.result.failed).toEqual([]);
    const app = (path: string) => f.apps.find((a) => a.domain === `shop.example.com${path}`)!;
    expect(app("/api/partner").policies?.map((p) => [p.name, p.decision, p.include])).toEqual([
      ["infra-sync: web exception", "bypass", [{ ip: { ip: "198.51.100.0/24" } }]],
      ["infra-sync: web exception service tokens", "non_identity", [{ service_token: { token_id: UPTIME_TOKEN } }]],
    ]);
    expect(app("/api/monitor").policies?.map((p) => p.decision)).toEqual(["non_identity"]);
    expect(app("/webhooks").policies?.map((p) => [p.name, p.decision, p.include, p.precedence])).toEqual([
      ["infra-sync: web exception", "bypass", [{ ip: { ip: "203.0.113.9/32" } }], 1],
    ]);
    expect(app("/hooks").policies?.map((p) => [p.name, p.decision, p.include, p.precedence])).toEqual([["infra-sync: web exception", "bypass", [{ everyone: {} }], 1]]);
    expect(changes(await planOnly(f))).toEqual([]);
  });
});

describe("zones", () => {
  it("refuses to plan when the account's zones differ from account.yaml (one error, no ops)", async () => {
    const f = exampleFixture();
    f.zones.push({ id: "zone-extra", name: "example.edu" });
    f.dns["zone-extra"] = [];
    const r = await run(f);
    expect(r.plan.ops).toEqual([]);
    expect(r.plan.diagnostics).toEqual([expect.objectContaining({ level: "error", code: "cloudflare-zones", message: expect.stringContaining("not in account.yaml: example.edu") })]);
    expect(f.writes()).toEqual([]);

    const g = exampleFixture();
    const r2 = await run(g, { account: testAccount({ zones: ["example.com", "example.net", "example.org", "example.info"] }) });
    expect(r2.plan.diagnostics[0]!.message).toContain("not in the account: example.info");
  });
});

describe("frozen and new droplets", () => {
  it("a frozen droplet's changes are planned as report ops and never applied; others still apply", async () => {
    const f = exampleFixture();
    f.frozen.add("click.example.com");
    const r = await run(f);
    const frozen = r.plan.ops.filter((o) => o.droplet === "click.example.com");
    expect(frozen.length).toBeGreaterThan(0);
    expect(frozen.every((o) => o.action === "report" && o.reason.startsWith("frozen droplet"))).toBe(true);
    expect(f.targets.some((t) => t.hostname === "click.example.com")).toBe(false);
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "ssh-click.example.com")).toBe(false);
    expect(f.targets.some((t) => t.hostname === "staging.esim.example.com")).toBe(true);
  });

  it("a hostname removed from a frozen droplet's file keeps its objects (attributed by its route's IP)", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(12, "shop.example.com", "nyc1", "10.0.0.31", ["env-prod", "web-public"])];
    f.sites["shop.example.com"] = { hostnames: ["shop.example.net"] };
    await run(f);
    expect(f.dns[Z_NET]!.some((r) => r.name === "shop.example.net")).toBe(true);
    f.sites["shop.example.com"] = { hostnames: [] };
    f.frozen.add("shop.example.com");
    const r = await run(f);
    const stale = r.plan.ops.filter((o) => o.key.includes("shop.example.net"));
    expect(stale.length).toBeGreaterThanOrEqual(2);
    expect(stale.every((o) => o.droplet === "shop.example.com" && o.action === "report")).toBe(true);
    expect(f.dns[Z_NET]!.some((x) => x.name === "shop.example.net")).toBe(true);
    expect(f.tunnels[T_NYC1]!.config!.ingress!.some((x) => x.hostname === "shop.example.net")).toBe(true);
  });

  it("a droplet about to be created gets pending ops with placeholders; apply leaves them for the re-plan", async () => {
    const f = new FakeCloudflare();
    f.toCreate["new.example.com"] = { env: "prod", tags: ["web-staff"] };
    const r = await run(f);
    const mine = r.plan.ops.filter((o) => o.droplet === "new.example.com");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((o) => o.pending === true && o.action === "create")).toBe(true);
    expect(JSON.stringify(mine)).toContain(KNOWN_AFTER_CREATE);
    expect(f.writes().filter((c) => JSON.stringify(c.body ?? "").includes("new.example.com"))).toEqual([]);
  });

  it("a droplet with no file is left alone: its objects are neither changed nor deleted", async () => {
    const f = exampleFixture();
    await run(f);
    f.noFile.add("click.example.com");
    f.droplets[1] = { ...f.droplets[1]!, privateIp: "10.0.0.99" };
    const p = await planOnly(f);
    expect(p.ops.filter((o) => (o.droplet ?? o.key).includes("click"))).toEqual([]);
  });
});

describe("guard rails", () => {
  it("deletes over the limit become report ops with the reason (a warning); creates still apply", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "click.example.com" && d.name !== "staging.esim.example.com");
    f.droplets.push(droplet(20, "fresh.example.com", "nyc1", "10.0.0.40", ["env-prod"]));
    const r = await run(f, { account: testAccount({ guards: { max_deletes: 3, max_delete_fraction: 0.3 } }) });
    const reports = r.plan.ops.filter((o) => o.action === "report");
    expect(reports.length).toBeGreaterThan(3);
    expect(reports.every((o) => /not deleted this run: refusing to delete/.test(o.reason))).toBe(true);
    expect(r.plan.ops.some((o) => o.action === "delete")).toBe(false);
    expect(r.plan.diagnostics.some((d) => d.code === "cloudflare-guard" && d.level === "warning")).toBe(true);
    expect(f.targets.some((t) => t.hostname === "click.example.com")).toBe(true);
    expect(f.targets.some((t) => t.hostname === "fresh.example.com")).toBe(true);
  });
});

describe("apply from ops alone", () => {
  it("a route whose rules changed since the plan is not overwritten (and its CNAME waits)", async () => {
    const f = exampleFixture();
    const ctx = testContext(f);
    const desired = desiredFor(f);
    const observed = await observeCloudflare(ctx);
    const plan = planCloudflare(desired, observed);
    // Someone adds a rule for the same name by hand between plan and apply.
    f.tunnels[T_NYC1]!.config!.ingress!.unshift({ hostname: "ssh-click.example.com", service: "ssh://192.0.2.1:22" });
    const res = await applyCloudflare(ctx, plan.ops.filter(isChange), observed);
    expect(res.failed.map((x) => x.op.key)).toContain(`${T_NYC1} ssh-click.example.com`);
    expect(res.skipped.map((x) => x.op.key)).toContain("CNAME ssh-click.example.com");
    expect(f.tunnels[T_NYC1]!.config!.ingress![0]).toEqual({ hostname: "ssh-click.example.com", service: "ssh://192.0.2.1:22" });
  });

  it("a read-only run plans but refuses every write before sending it", async () => {
    const f = exampleFixture();
    const ctx = testContext(f, testAccount(), false);
    const observed = await observeCloudflare(ctx);
    const plan = planCloudflare(desiredFor(f), observed);
    expect(changes(plan).length).toBeGreaterThan(0);
    const res = await applyCloudflare(ctx, changes(plan), observed);
    expect(res.applied).toEqual([]);
    expect(res.failed.every((x) => x.error.includes("read-only"))).toBe(true);
    expect(f.writes()).toEqual([]);
    expect(WriteNotAllowedError.name).toBe("WriteNotAllowedError");
  });

  it("observe: a tunnel or zone that can't be read is an { error }, and blocks deletions", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "click.example.com");
    f.failWhen((c) => (c.method === "GET" && c.path.endsWith(`/zones/${Z_NET}/dns_records`) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(r.observed.dns[Z_NET]).toEqual({ error: expect.stringContaining("HTTP 500") });
    expect(r.errors.some((e) => e.includes(Z_NET))).toBe(true);
    expect(r.plan.ops.some((o) => o.action === "delete")).toBe(false);
    expect(f.targets.some((t) => t.hostname === "click.example.com")).toBe(true);
  });

  it("the provider wires observe, diff and apply with the token from the environment", async () => {
    const f = exampleFixture();
    const ctx = testContext(f);
    const p = createCloudflareProvider(ctx);
    const desired = desiredFor(f);
    const obs = await p.observe(desired);
    const plan = p.diff(desired, obs);
    const res = await p.apply(changes(plan), obs);
    expect(res.failed).toEqual([]);
    expect(f.calls.every((c) => !c.url.includes("cf-test-token"))).toBe(true);
  });
});
