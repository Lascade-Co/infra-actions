// Ported from the infra-sync Worker's test/sync.test.ts (fail closed, ownership, deletion, repair,
// updates, vpc- records, healthcheck bypass, renaming), with fake data and droplet files as input.

import { describe, expect, it } from "vitest";
import { applyCloudflare, observeCloudflare, planCloudflare } from "../../src/cloudflare/index.js";
import { isChange } from "../../src/core/plan.js";
import {
  type Call,
  changes,
  desiredFor,
  droplet,
  exampleFixture,
  FakeCloudflare,
  idx,
  isAppPost,
  isDnsPost,
  isTargetPost,
  isTunnelPutWith,
  run,
  type RunResult,
  T_BLR1,
  T_NYC1,
  testAccount,
  testContext,
  Z_COM,
} from "./fake.js";

const diags = (r: RunResult, code: string) => r.plan.diagnostics.filter((d) => d.code === code);
const diagFor = (r: RunResult, code: string, droplet: string) => diags(r, code).find((d) => d.droplet === droplet)?.message;
const newWrites = (f: FakeCloudflare, from: number): Call[] => f.calls.slice(from).filter((c) => c.method !== "GET");
const appliedDeletes = (r: RunResult) => r.result.applied.filter((o) => o.action === "delete");

describe("fail closed", () => {
  it("app creation fails -> no ingress rule and no DNS for that droplet; others proceed", async () => {
    const f = exampleFixture();
    f.failWhen((c) => (isAppPost("ssh-staging-esim.example.com")(c) ? { status: 500 } : undefined));
    const r = await run(f);
    const w = f.writes();
    expect(idx(w, isTargetPost("staging.esim.example.com"))).toBeGreaterThanOrEqual(0);
    expect(w.some(isTunnelPutWith(T_BLR1, "ssh-staging-esim.example.com"))).toBe(false);
    expect(w.some(isDnsPost("ssh-staging-esim.example.com"))).toBe(false);
    expect(r.result.failed.map((x) => x.op.key)).toContain("ssh-staging-esim.example.com");
    expect(r.result.skipped.map((x) => x.op.key)).toEqual(expect.arrayContaining([`${T_BLR1} ssh-staging-esim.example.com`, "CNAME ssh-staging-esim.example.com"]));
    // click.example.com is unaffected
    expect(w.some(isDnsPost("ssh-click.example.com"))).toBe(true);
  });

  it("target creation fails -> no app, no route, no DNS", async () => {
    const f = exampleFixture();
    f.failWhen((c) => (isTargetPost("click.example.com")(c) ? { status: 500 } : undefined));
    const r = await run(f);
    const w = f.writes();
    expect(w.some(isAppPost("ssh-click.example.com"))).toBe(false);
    expect(w.some(isTunnelPutWith(T_NYC1, "ssh-click.example.com"))).toBe(false);
    expect(w.some(isDnsPost("ssh-click.example.com"))).toBe(false);
    expect(r.result.failed.map((x) => `${x.op.kind} ${x.op.key}`)).toEqual(["infra-target click.example.com"]);
  });

  it("tunnel PUT fails -> no DNS record", async () => {
    const f = exampleFixture();
    f.failWhen((c) => (c.method === "PUT" && c.path.includes(`/cfd_tunnel/${T_NYC1}/`) ? { status: 500 } : undefined));
    const r = await run(f);
    const w = f.writes();
    expect(w.some(isAppPost("ssh-click.example.com"))).toBe(true);
    expect(w.some(isDnsPost("ssh-click.example.com"))).toBe(false);
    expect(w.some(isDnsPost("ssh-staging-esim.example.com"))).toBe(true);
    expect(r.result.failed.map((x) => x.op.key)).toContain(`${T_NYC1} ssh-click.example.com`);
  });

  it("an unreadable tunnel blocks its droplets' hostnames and all deletions", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "staging.esim.example.com");
    f.droplets.push(droplet(12, "new.example.com", "nyc1", "10.0.0.61", ["env-prod"]));
    f.failWhen((c) => (c.method === "GET" && c.path.includes(`/cfd_tunnel/${T_NYC1}/`) ? { status: 500 } : undefined));
    const before = f.calls.length;
    const r = await run(f);
    const w = newWrites(f, before);
    expect(w.some(isAppPost("ssh-new.example.com"))).toBe(false);
    expect(w.some((c) => c.method === "DELETE")).toBe(false);
    expect(r.errors.join("\n")).toMatch(T_NYC1);
    expect(diags(r, "cloudflare-read-error")).not.toHaveLength(0);
    // The deletes are shown, not performed.
    const deletes = r.plan.ops.filter((o) => o.reason.includes("not deleted this run"));
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes.every((o) => o.action === "report")).toBe(true);
    expect(diagFor(r, "cloudflare-skipped", "new.example.com")).toMatch(/configuration unavailable/);
  });
});

describe("ownership and conflicts", () => {
  it("does not overwrite a DNS record without the marker; reports the conflict and creates no app/route", async () => {
    const f = exampleFixture();
    f.dns[Z_COM]!.push({ id: "manual-a", name: "ssh-click.example.com", type: "A", content: "203.0.113.9", proxied: false, comment: null });
    const r = await run(f);
    const w = f.writes();
    expect(diagFor(r, "cloudflare-conflict", "click.example.com")).toMatch(/no "managed-by:infra-sync" comment/);
    expect(diags(r, "cloudflare-conflict").every((d) => d.level === "warning")).toBe(true);
    expect(w.some((c) => c.path.endsWith("/dns_records/manual-a"))).toBe(false);
    expect(w.some(isAppPost("ssh-click.example.com"))).toBe(false);
    expect(w.some(isTunnelPutWith(T_NYC1, "ssh-click.example.com"))).toBe(false);
    expect(w.some(isDnsPost("ssh-click.example.com"))).toBe(false);
    expect(f.dns[Z_COM]!.find((r) => r.id === "manual-a")).toMatchObject({ type: "A", content: "203.0.113.9" });
    // the target is still managed (it does not use the hostname)
    expect(w.some(isTargetPost("click.example.com"))).toBe(true);
  });

  it("updates its own DNS record when it points at the wrong tunnel", async () => {
    const f = exampleFixture();
    await run(f);
    const rec = f.dns[Z_COM]!.find((r) => r.name === "ssh-click.example.com")!;
    rec.content = "00000000-0000-4000-8000-0000000000ff.cfargotunnel.com";
    const before = f.calls.length;
    await run(f);
    expect(newWrites(f, before).map((c) => `${c.method} ${c.path}`)).toEqual([`PATCH /client/v4/zones/${Z_COM}/dns_records/${rec.id}`]);
    expect(f.dns[Z_COM]!.find((r) => r.id === rec.id)?.content).toBe(`${T_NYC1}.cfargotunnel.com`);
  });

  it("treats the manual ssh-spike rule and its manual Access app as someone else's", async () => {
    const f = exampleFixture();
    f.droplets.push(droplet(7, "spike.example.com", "nyc1", "10.0.0.30", ["env-staging"]));
    const r = await run(f);
    expect(diagFor(r, "cloudflare-conflict", "spike.example.com")).toMatch(/spike-a \(temporary\)/);
    expect(f.writes().some(isAppPost("ssh-spike.example.com"))).toBe(false);
    expect(f.tunnels[T_NYC1]!.config?.ingress?.[0]).toEqual({ hostname: "ssh-spike.example.com", service: "ssh://localhost:22" });
    expect(f.apps.find((a) => a.id === "manual-spike-a")).toBeDefined();
  });

  it("does not adopt a target it did not create", async () => {
    const f = exampleFixture();
    f.targets.push({ id: "manual-t", hostname: "click.example.com", ip: { ipv4: { ip_addr: "10.0.0.3" } }, tags: {} });
    const r = await run(f);
    expect(diagFor(r, "cloudflare-conflict", "click.example.com")).toMatch(/manual-t/);
    expect(f.writes().some((c) => c.path.includes("manual-t"))).toBe(false);
    expect(f.writes().some(isAppPost("ssh-click.example.com"))).toBe(false);
  });

  it("reports droplets that flatten to the same hostname and manages neither", async () => {
    const f = exampleFixture();
    f.droplets.push(droplet(8, "a.b.example.com", "nyc1", "10.0.0.40", []), droplet(9, "a-b.example.com", "nyc1", "10.0.0.41", []));
    const r = await run(f);
    expect(diags(r, "cloudflare-conflict").map((d) => d.droplet).sort()).toEqual(["a-b.example.com", "a.b.example.com"]);
    expect(f.writes().some((c) => c.body?.domain === "ssh-a-b.example.com")).toBe(false);
    expect(f.writes().some((c) => c.body?.hostname === "a.b.example.com" || c.body?.hostname === "a-b.example.com")).toBe(false);
  });

  it("warns when a deploy target has no env (no service-token policy)", async () => {
    const f = exampleFixture();
    f.droplets.push(droplet(10, "deploy.example.com", "nyc1", "10.0.0.50", ["ci-deploy"]));
    const r = await run(f);
    expect(r.warnings.join("\n")).toMatch(/deploy\.example\.com: deploy: true but no env; no CI service-token policy added/);
    expect(f.apps.find((a) => a.domain === "ssh-deploy.example.com")?.policies?.map((p) => p.decision)).toEqual(["allow"]);
  });

  it("droplets with no file are left alone: nothing created, nothing of theirs deleted", async () => {
    const f = exampleFixture();
    await run(f);
    // click.example.com loses its file but the droplet still exists.
    f.noFile.add("click.example.com");
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before)).toEqual([]);
    expect(changes(r.plan)).toEqual([]);
    expect(f.targets.some((t) => t.hostname === "click.example.com")).toBe(true);
  });
});

describe("deletion", () => {
  it("deletes DNS -> ingress -> app -> target for a droplet that is gone, keeping manual rules", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "click.example.com");
    const before = f.calls.length;
    const r = await run(f);
    const order = newWrites(f, before).map((c) => `${c.method} ${c.path.replace(/\/client\/v4/, "")}`);
    const iDns = order.findIndex((x) => x.startsWith(`DELETE /zones/${Z_COM}/dns_records/`));
    const iTun = order.findIndex((x) => x.startsWith("PUT /accounts/") && x.includes(T_NYC1));
    const iApp = order.findIndex((x) => x.startsWith("DELETE") && x.includes("/access/apps/"));
    const iTgt = order.findIndex((x) => x.startsWith("DELETE") && x.includes("/infrastructure/targets/"));
    expect([iDns, iTun, iApp, iTgt].every((x) => x >= 0)).toBe(true);
    expect(iDns).toBeLessThan(iTun);
    expect(iTun).toBeLessThan(iApp);
    expect(iApp).toBeLessThan(iTgt);
    expect(f.tunnels[T_NYC1]!.config?.ingress).toEqual([
      { hostname: "ssh-spike.example.com", service: "ssh://localhost:22" },
      { hostname: "pg-spike.example.com", service: "tcp://localhost:55432" },
      { service: "http_status:404" },
    ]);
    expect(f.apps.some((a) => a.id === "manual-spike-a")).toBe(true);
    expect(appliedDeletes(r)).toHaveLength(5);
    expect(appliedDeletes(r).map((o) => `${o.kind} ${o.key}`)).toContain("dns-record A vpc-click.example.com");
    expect(r.errors).toEqual([]);
  });

  it("keeps the app and target when the DNS delete fails", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "click.example.com");
    f.failWhen((c) => (c.method === "DELETE" && c.path.includes("/dns_records/") ? { status: 500 } : undefined));
    const before = f.calls.length;
    const r = await run(f);
    const w = newWrites(f, before);
    expect(w.some((c) => c.method === "PUT" && c.path.includes(T_NYC1))).toBe(false);
    expect(w.some((c) => c.method === "DELETE" && c.path.includes("/access/apps/"))).toBe(false);
    expect(w.some((c) => c.method === "DELETE" && c.path.includes("/infrastructure/targets/"))).toBe(false);
    expect(f.tunnels[T_NYC1]!.config?.ingress?.some((x) => x.hostname === "ssh-click.example.com")).toBe(true);
    expect(r.result.failed.map((x) => x.op.key)).toContain("CNAME ssh-click.example.com");
  });

  it("keeps a droplet's objects while it temporarily has no private IP", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.map((d) => (d.name === "click.example.com" ? droplet(2, d.name, "nyc1", null, ["env-prod"]) : d));
    const before = f.calls.length;
    const r = await run(f);
    expect(f.calls.slice(before).filter((c) => c.method === "DELETE")).toEqual([]);
    expect(diagFor(r, "cloudflare-skipped", "click.example.com")).toMatch(/no private IPv4/);
  });

  it("refuses mass deletion beyond the guards (report ops), until account guards are raised", async () => {
    const f = new FakeCloudflare();
    f.droplets = Array.from({ length: 10 }, (_, i) => droplet(100 + i, `host${i}.example.com`, "nyc1", `10.0.2.${i + 1}`, ["env-prod"]));
    await run(f);
    expect(f.targets).toHaveLength(10);
    // Eight of ten droplet files removed at once.
    f.droplets = f.droplets.slice(0, 2);
    let before = f.calls.length;
    const blocked = await run(f, { account: testAccount({ guards: { max_deletes: 100, max_delete_fraction: 0.3 } }) });
    expect(f.calls.slice(before).filter((c) => c.method === "DELETE")).toEqual([]);
    expect(f.calls.slice(before).some((c) => c.method === "PUT" && c.path.includes("cfd_tunnel"))).toBe(false);
    expect(diags(blocked, "cloudflare-guard").map((d) => [d.level, d.message])).toEqual([["warning", expect.stringMatching(/refusing to delete 40 of 51 managed objects/)]]);
    expect(blocked.errors).toEqual([]);
    expect(blocked.plan.ops.filter((o) => o.action === "report")).toHaveLength(40);
    expect(blocked.plan.ops.filter((o) => o.action === "delete")).toEqual([]);
    expect(f.targets).toHaveLength(10);

    const byCount = await run(f, { account: testAccount({ guards: { max_deletes: 20, max_delete_fraction: 1 } }) });
    expect(diags(byCount, "cloudflare-guard")[0]?.message).toMatch(/refusing to delete 40 objects \(> guards\.max_deletes=20\)/);

    before = f.calls.length;
    await run(f, { account: testAccount({ guards: { max_deletes: 100, max_delete_fraction: 1 } }) });
    expect(f.calls.slice(before).filter((c) => c.method === "DELETE").length).toBe(32); // 8 ssh- DNS + 8 vpc- DNS + 8 apps + 8 targets
    expect(f.targets).toHaveLength(2);
  });

  it("allows deleting one droplet out of two (small fleet)", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(1, "a.example.com", "nyc1", "10.0.0.2", ["env-prod"]), droplet(2, "b.example.com", "nyc1", "10.0.0.3", ["env-prod"])];
    await run(f);
    f.droplets = f.droplets.slice(0, 1);
    const r = await run(f);
    expect(appliedDeletes(r)).toHaveLength(5);
    expect(r.errors).toEqual([]);
    expect(diags(r, "cloudflare-guard")).toEqual([]);
  });
});

describe("repair and partial reads", () => {
  it("recreates an Access app deleted out-of-band (route stays owned via its marked DNS record) and warns", async () => {
    const f = exampleFixture();
    await run(f);
    f.apps = f.apps.filter((a) => a.domain !== "ssh-click.example.com");
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before).map((c) => c.method + " " + (c.body?.domain ?? c.path))).toEqual(["POST ssh-click.example.com"]);
    expect(diags(r, "cloudflare-conflict")).toEqual([]);
    // A warning, not an error: an error would block the apply that repairs it.
    expect(diags(r, "cloudflare-repair").map((d) => [d.level, d.message])).toEqual([["warning", expect.stringMatching(/route ssh-click\.example\.com has no "infra-sync:" Access app/)]]);
    expect(r.errors).toEqual([]);
    expect(f.apps.filter((a) => a.domain === "ssh-click.example.com")).toHaveLength(1);
  });

  it("removes the route if the missing Access app cannot be recreated (never leave it unprotected)", async () => {
    const f = exampleFixture();
    await run(f);
    f.apps = f.apps.filter((a) => a.domain !== "ssh-click.example.com");
    f.failWhen((c) => (isAppPost("ssh-click.example.com")(c) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(f.tunnels[T_NYC1]!.config?.ingress?.some((x) => x.hostname === "ssh-click.example.com")).toBe(false);
    expect(f.tunnels[T_NYC1]!.config?.ingress?.[0]).toEqual({ hostname: "ssh-spike.example.com", service: "ssh://localhost:22" });
    expect(r.result.applied.find((o) => o.kind === "tunnel-ingress")).toMatchObject({ action: "delete", key: `${T_NYC1} ssh-click.example.com`, reason: expect.stringMatching(/fail closed/) });
  });

  it("skips a tunnel that is not remotely managed and makes no deletions", async () => {
    const f = exampleFixture();
    await run(f);
    f.tunnels[T_NYC1]!.source = "local";
    f.droplets = f.droplets.filter((d) => d.name !== "staging.esim.example.com");
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before)).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/not remotely managed/);
  });

  it("an unreadable DNS zone blocks that zone's hostnames and all deletions", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "staging.esim.example.com");
    f.droplets.push(droplet(11, "new.example.com", "nyc1", "10.0.0.60", ["env-prod"]));
    f.failWhen((c) => (c.method === "GET" && c.path.endsWith(`/zones/${Z_COM}/dns_records`) ? { status: 500 } : undefined));
    const before = f.calls.length;
    const r = await run(f);
    const w = newWrites(f, before);
    expect(w.some((c) => c.method === "DELETE")).toBe(false);
    expect(w.some(isAppPost("ssh-new.example.com"))).toBe(false);
    expect(w.some(isTargetPost("new.example.com"))).toBe(true);
    expect(diagFor(r, "cloudflare-skipped", "new.example.com")).toMatch(/DNS records of zone example\.com unavailable/);
    expect(diags(r, "cloudflare-read-error").every((d) => d.level === "error")).toBe(true);
    expect(diags(r, "cloudflare-read-error").length).toBeGreaterThan(0);
  });
});

describe("updates", () => {
  it("moves a droplet that changed region and IP to the new tunnel", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.map((d) => (d.name === "click.example.com" ? droplet(2, d.name, "blr1", "10.0.1.77", ["env-prod"]) : d));
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    expect(f.targets.find((t) => t.hostname === "click.example.com")?.ip.ipv4?.ip_addr).toBe("10.0.1.77");
    expect(f.tunnels[T_NYC1]!.config?.ingress?.some((x) => x.hostname === "ssh-click.example.com")).toBe(false);
    expect(f.tunnels[T_BLR1]!.config?.ingress).toContainEqual({ hostname: "ssh-click.example.com", service: "ssh://10.0.1.77:22" });
    expect(f.dns[Z_COM]!.find((x) => x.name === "ssh-click.example.com")?.content).toBe(`${T_BLR1}.cfargotunnel.com`);
    expect(f.apps.filter((a) => a.domain === "ssh-click.example.com")).toHaveLength(1);
  });

  it("updates app policies in place (keeping policy ids) when an SSH group changes", async () => {
    const f = exampleFixture();
    await run(f);
    const app = f.apps.find((a) => a.domain === "ssh-click.example.com")!;
    const polId = app.policies![0]!.id;
    const before = f.calls.length;
    await run(f, { account: { ...testAccount(), ssh_groups: { admins: ["admin@example.com"] } } });
    const puts = f.calls.slice(before).filter((c) => c.method === "PUT" && c.path.includes("/access/apps/"));
    // The 2 ssh- apps. The infrastructure app belongs to the access set: a new set's app is
    // created and the old set's deleted (test/cloudflare/ssh-access.test.ts).
    expect(puts.length).toBe(2);
    const updated = f.apps.find((a) => a.id === app.id)!;
    expect(updated.policies?.[0]).toMatchObject({ id: polId, include: [{ email: { email: "admin@example.com" } }] });
  });
});

describe("never plan on a bad source", () => {
  it("observe fails when the zone list is empty; nothing is written", async () => {
    const f = exampleFixture();
    await run(f);
    const before = f.calls.length;
    f.zones = [];
    await expect(observeCloudflare(testContext(f))).rejects.toThrow(/zero zones/);
    expect(newWrites(f, before)).toEqual([]);
  });
});

describe("read-only runs (the Worker's dry run)", () => {
  it("plans the changes, and apply with a read-only client writes nothing", async () => {
    const f = exampleFixture();
    const ctx = testContext(f, testAccount(), false);
    const observed = await observeCloudflare(ctx);
    const plan = planCloudflare(desiredFor(f), observed);
    const ops = plan.ops.filter((o) => isChange(o) && !o.pending);
    expect(ops.map((o) => `${o.action} ${o.kind} ${o.key}`)).toEqual(
      expect.arrayContaining([
        "create infra-target click.example.com",
        "create access-app ssh-click.example.com",
        `create tunnel-ingress ${T_BLR1} ssh-staging-esim.example.com`,
        "create dns-record CNAME ssh-click.example.com",
      ]),
    );
    const res = await applyCloudflare(ctx, ops, observed);
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(res.applied).toEqual([]);
    expect(res.failed.length).toBeGreaterThan(0);
    expect(res.failed.every((x) => /read-only/.test(x.error))).toBe(true);
  });

  it("deletions are planned in a read-only run but not executed", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "click.example.com");
    const before = f.calls.length;
    const ctx = testContext(f, testAccount(), false);
    const plan = planCloudflare(desiredFor(f), await observeCloudflare(ctx));
    expect(newWrites(f, before)).toEqual([]);
    expect(plan.ops.filter((o) => o.action === "delete")).toHaveLength(5);
  });
});

describe("vpc-<label>.<zone> records", () => {
  const vpcRec = (f: FakeCloudflare, name: string) => (f.dns[Z_COM] ?? []).find((r) => r.name === name);

  it("gives every qualifying droplet a DNS-only A record vpc-<label>.<zone> -> private IP, with the marker", async () => {
    const f = exampleFixture();
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(vpcRec(f, "vpc-click.example.com")).toMatchObject({ type: "A", content: "10.0.0.3", proxied: false, ttl: 60, comment: "managed-by:infra-sync" });
    // Flattened exactly like ssh-.
    expect(vpcRec(f, "vpc-staging-esim.example.com")).toMatchObject({ type: "A", content: "10.0.1.5", proxied: false });
    expect(r.result.applied.find((o) => o.key === "A vpc-click.example.com")).toMatchObject({ action: "create", after: { content: "10.0.0.3" } });
  });

  it("still creates the vpc- record when the droplet's ssh- hostname is blocked by a foreign record", async () => {
    const f = exampleFixture();
    f.dns[Z_COM]!.push({ id: "manual-ssh", name: "ssh-click.example.com", type: "A", content: "192.0.2.4", proxied: false, comment: null });
    const r = await run(f);
    expect(diagFor(r, "cloudflare-conflict", "click.example.com")).toBeDefined();
    expect(vpcRec(f, "vpc-click.example.com")).toMatchObject({ content: "10.0.0.3" });
  });

  it("does not overwrite a vpc- record without the marker; reports a conflict and still manages SSH", async () => {
    const f = exampleFixture();
    f.dns[Z_COM]!.push({ id: "manual-vpc", name: "vpc-click.example.com", type: "A", content: "10.0.9.9", proxied: false, comment: null });
    const r = await run(f);
    expect(vpcRec(f, "vpc-click.example.com")).toMatchObject({ id: "manual-vpc", content: "10.0.9.9" });
    expect(diagFor(r, "cloudflare-conflict", "click.example.com")).toMatch(/vpc-click\.example\.com not managed/);
    expect(f.apps.some((a) => a.domain === "ssh-click.example.com")).toBe(true);
    // A second run leaves the foreign record alone and deletes nothing.
    const before = f.calls.length;
    await run(f);
    expect(f.calls.slice(before).filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("updates its own record in place when the private IP changes", async () => {
    const f = exampleFixture();
    await run(f);
    const id = vpcRec(f, "vpc-click.example.com")!.id;
    f.droplets = f.droplets.map((d) => (d.name === "click.example.com" ? droplet(d.id, d.name, "nyc1", "10.0.0.99", d.tags) : d));
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before).some((c) => c.method === "PATCH" && c.path.endsWith(`/dns_records/${id}`))).toBe(true);
    expect(vpcRec(f, "vpc-click.example.com")).toMatchObject({ id, content: "10.0.0.99" });
    expect(r.result.applied.find((o) => o.key === "A vpc-click.example.com")).toMatchObject({ action: "update", after: { content: "10.0.0.99" } });
  });

  it("keeps the vpc- record while the droplet temporarily has no private IP", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.map((d) => (d.name === "click.example.com" ? droplet(d.id, d.name, "nyc1", null, d.tags) : d));
    await run(f);
    expect(vpcRec(f, "vpc-click.example.com")).toBeDefined();
  });
});

describe("public /healthcheck for deploy targets", () => {
  const health = (f: FakeCloudflare, name: string) => f.apps.find((a) => a.name === `infra-sync: healthcheck ${name}`);

  it("gives a deploy target a Bypass app on <name>/healthcheck, and nothing to others", async () => {
    const f = exampleFixture();
    const r = await run(f);
    expect(r.errors).toEqual([]);
    const app = health(f, "staging.esim.example.com")!; // deploy: true in the fixture
    expect(app).toMatchObject({ type: "self_hosted", domain: "staging.esim.example.com/healthcheck", app_launcher_visible: false });
    expect(app.policies?.map((p) => [p.decision, p.include])).toEqual([["bypass", [{ everyone: {} }]]]);
    expect(health(f, "click.example.com")).toBeUndefined(); // not a deploy target
    expect(r.result.applied.some((o) => o.key === "staging.esim.example.com/healthcheck" && o.action === "create")).toBe(true);
  });

  it("is not mistaken for an ssh- app: a second run makes no writes", async () => {
    const f = exampleFixture();
    await run(f);
    const before = f.calls.length;
    await run(f);
    expect(newWrites(f, before)).toEqual([]);
  });

  it("leaves a manual app that already covers the path alone, with a warning", async () => {
    const f = exampleFixture();
    f.apps.push({ id: "manual-hc", name: "esim public paths", type: "self_hosted", domain: "staging.esim.example.com/healthcheck/" });
    const r = await run(f);
    expect(health(f, "staging.esim.example.com")).toBeUndefined();
    expect(r.warnings.join("\n")).toMatch(/already covers staging\.esim\.example\.com\/healthcheck/);
    expect(f.apps.some((a) => a.id === "manual-hc")).toBe(true);
  });

  it("removes the bypass when deploy is turned off, and keeps the ssh- app", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.map((d) => (d.name === "staging.esim.example.com" ? { ...d, tags: ["env-staging"] } : d));
    const r = await run(f);
    expect(health(f, "staging.esim.example.com")).toBeUndefined();
    expect(appliedDeletes(r).map((o) => o.key)).toContain("staging.esim.example.com/healthcheck");
    expect(f.apps.some((a) => a.domain === "ssh-staging-esim.example.com")).toBe(true);
  });

  it("deletes all six objects of a gone deploy target (within the one-droplet floor)", async () => {
    const f = exampleFixture();
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== "staging.esim.example.com");
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(appliedDeletes(r)).toHaveLength(6);
    expect(health(f, "staging.esim.example.com")).toBeUndefined();
  });
});

describe("renaming a droplet", () => {
  it("updates its target in place (same private IP) instead of creating a second one", async () => {
    const f = exampleFixture();
    await run(f);
    const id = f.targets.find((t) => t.hostname === "staging.esim.example.com")!.id;
    f.droplets = f.droplets.map((d) => (d.name === "staging.esim.example.com" ? { ...d, name: "staging-esim.example.com" } : d));
    const before = f.calls.length;
    const r = await run(f);
    expect(r.errors).toEqual([]);
    const w = newWrites(f, before);
    expect(w.some((c) => c.method === "POST" && c.path.endsWith("/infrastructure/targets"))).toBe(false);
    expect(w.some((c) => c.method === "DELETE" && c.path.includes("/infrastructure/targets/"))).toBe(false);
    expect(f.targets.filter((t) => t.ip?.ipv4?.ip_addr === "10.0.1.5")).toHaveLength(1);
    expect(f.targets.find((t) => t.id === id)?.hostname).toBe("staging-esim.example.com");
    // Both names flatten to the same ssh- and vpc- names, so those are untouched.
    expect(f.apps.some((a) => a.domain === "ssh-staging-esim.example.com")).toBe(true);
  });
});
