// Sites (web.exposure staff / public), ported from the infra-sync Worker's "sites: ..." tests with
// fake data. The Worker's web tags become the droplet file's web.exposure (fake.ts turns the tags
// into files) and web-config.json becomes f.sites.
//
// Not ported: web-config.json parsing (the loader's job), the test against the Worker's bundled
// web-config.json (real data), "both tags at once" (a droplet file can't say it), the Worker's dry
// run (here: a plan without apply) and the cutover / health-watch parts (they stay in the Worker).

import { describe, expect, it } from "vitest";
import type { WebException } from "../../src/core/model.js";
import type { PlanOp } from "../../src/core/plan.js";
import type { IngressRule } from "../../src/cloudflare/types.js";
import {
  type Call,
  changes,
  droplet,
  exampleFixture,
  type FakeCloudflare,
  idx,
  isAppPost,
  isDnsPost,
  isTunnelPutWith,
  planOnly,
  run,
  type RunResult,
  type SiteCfg,
  STAFF_POLICY,
  T_BLR1,
  T_NYC1,
  Z_COM,
  Z_NET,
} from "./fake.js";

const PILOT = "staging-pilot.example.com";
const PILOT_IP = "10.0.1.40";
const MANUAL_DASHBOARD = {
  hostname: "manual-dashboard.example.com",
  service: "https://10.0.1.13:443",
  originRequest: { originServerName: "dashboard.internal.example.com" },
};

const pilot = (tags: string[], region = "blr1", ip = PILOT_IP) => droplet(40, PILOT, region, ip, ["env-staging", ...tags]);
const withPilot = (tags: string[], sites: Record<string, SiteCfg> = {}) => {
  const f = exampleFixture();
  f.droplets.push(pilot(tags));
  f.sites = sites;
  return f;
};
const retag = (f: FakeCloudflare, tags: string[], region?: string, ip?: string) => {
  f.droplets = f.droplets.map((d) => (d.name === PILOT ? pilot(tags, region, ip) : d));
};
const appAt = (f: FakeCloudflare, domain: string) => f.apps.find((a) => a.domain === domain);
const siteDns = (f: FakeCloudflare, name: string, zone = Z_COM) => (f.dns[zone] ?? []).filter((r) => r.name === name);
const route = (f: FakeCloudflare, host: string, tid = T_BLR1) => f.tunnels[tid]!.config?.ingress?.find((r) => r.hostname === host);
const rules = (f: FakeCloudflare, host: string, tid = T_BLR1) => (f.tunnels[tid]!.config?.ingress ?? []).filter((r) => r.hostname === host);
const newWrites = (f: FakeCloudflare, from: number) => f.calls.slice(from).filter((c) => c.method !== "GET");
const isAppDelete = (id: string) => (c: Call) => c.method === "DELETE" && c.path.endsWith(`/access/apps/${id}`);
const writeLines = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path.replace(/^\/client\/v4/, "").replace(/^\/accounts\/[^/]+/, "")}`);
/** Diagnostics of one code (the fixture always carries an unrelated "skipped" warning for old.example.com). */
const diags = (r: RunResult, code: string) => r.plan.diagnostics.filter((d) => d.code === code).map((d) => d.message);
const applied = (r: RunResult) => r.result.applied.map((o) => `${o.action} ${o.kind} ${o.key}`);
const op = (r: RunResult, kind: PlanOp["kind"], key: string) => r.plan.ops.find((o) => o.kind === kind && o.key === key);
const everyone = (path: string): WebException => ({ path, allow: "everyone" });

describe("sites: staff", () => {
  it("creates the Access app, then the route (https origin, noTLSVerify), then the proxied CNAME", async () => {
    const f = withPilot(["web-staff"]);
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    const w = f.writes();
    const a = idx(w, isAppPost(PILOT));
    const i = idx(w, isTunnelPutWith(T_BLR1, PILOT));
    const d = idx(w, isDnsPost(PILOT));
    expect([a, i, d].every((x) => x >= 0)).toBe(true);
    expect(a).toBeLessThan(i);
    expect(i).toBeLessThan(d);

    // App body as sent: whole host, the reusable staff policy by id, WARP authentication.
    expect(w[a]!.body).toEqual({
      name: `infra-sync: web ${PILOT}`,
      type: "self_hosted",
      domain: PILOT,
      app_launcher_visible: false,
      session_duration: "24h",
      allow_authenticate_via_warp: true,
      policies: [{ id: STAFF_POLICY, precedence: 1 }],
    });
    expect(route(f, PILOT)).toEqual({ hostname: PILOT, service: `https://${PILOT_IP}:443`, originRequest: { noTLSVerify: true } });
    expect(siteDns(f, PILOT)).toEqual([
      expect.objectContaining({ type: "CNAME", content: `${T_BLR1}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "managed-by:infra-sync" }),
    ]);
    // The manual rule with originRequest is untouched and still first; the SSH side still exists.
    expect(f.tunnels[T_BLR1]!.config?.ingress?.[0]).toEqual(MANUAL_DASHBOARD);
    expect(appAt(f, "ssh-staging-pilot.example.com")).toBeDefined();
    expect(applied(r)).toEqual(
      expect.arrayContaining([`create access-app ${PILOT}`, `create tunnel-ingress ${T_BLR1} ${PILOT}`, `create dns-record CNAME ${PILOT}`]),
    );
    // Every site op names its droplet file (grouping, frozen droplets).
    expect(r.plan.ops.filter((o) => o.key.includes(PILOT)).every((o) => o.droplet === PILOT)).toBe(true);
  });

  it("is idempotent with staff and public sites, paths, exceptions and extra hostnames: a second plan has no changes", async () => {
    const f = withPilot(["web-staff"], {
      [PILOT]: { hostnames: ["pilot-brand.example.net"], exceptions: [everyone("/api/webhooks/payments/")] },
      "shop.example.com": { origin: "http://{ip}:80", exceptions: [{ path: "/payment/internal/", allow: { ips: ["10.0.0.1/32", "198.51.100.206/32"] } }] },
    });
    f.droplets.push(droplet(41, "shop.example.com", "nyc1", "10.0.0.41", ["env-prod", "web-public", "ci-deploy"]));
    const first = await run(f);
    expect(first.errors).toEqual([]);
    expect(first.result.failed).toEqual([]);
    const before = f.calls.length;
    const second = await run(f);
    expect(newWrites(f, before)).toEqual([]);
    expect(changes(second.plan)).toEqual([]);
  });

  it("gives extra hostnames from the file the same treatment, in their own zone", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { hostnames: ["pilot-brand.example.net"] } });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    for (const [h, zone] of [
      [PILOT, Z_COM],
      ["pilot-brand.example.net", Z_NET],
    ] as const) {
      expect(appAt(f, h)?.name).toBe(`infra-sync: web ${h}`);
      expect(route(f, h)).toEqual({ hostname: h, service: `https://${PILOT_IP}:443`, originRequest: { noTLSVerify: true } });
      expect(siteDns(f, h, zone)).toHaveLength(1);
    }
  });

  it("refuses multi-level names (free certificate covers one level), creating nothing for them", async () => {
    const f = exampleFixture();
    f.droplets.push(droplet(42, "staging.ship.example.com", "blr1", "10.0.1.42", ["env-staging", "web-staff"]));
    f.droplets.push(pilot(["web-staff"]));
    f.sites = { [PILOT]: { hostnames: ["a.b.example.com"] } };
    const r = await run(f);
    const warn = r.warnings.join("\n");
    expect(warn).toMatch(/staging\.ship\.example\.com: site refused: .*only covers one level \(\*\.example\.com\).*staging-ship\.example\.com/);
    expect(warn).toMatch(/a\.b\.example\.com: site refused/);
    const w = f.writes();
    for (const h of ["staging.ship.example.com", "a.b.example.com"]) {
      expect(w.some(isAppPost(h))).toBe(false);
      expect(w.some(isDnsPost(h))).toBe(false);
      expect(route(f, h)).toBeUndefined();
    }
    // The refused droplet's SSH side and the one-level site are unaffected.
    expect(appAt(f, "ssh-staging-ship.example.com")).toBeDefined();
    expect(appAt(f, PILOT)).toBeDefined();
  });

  it("awaiting cutover: a foreign A record keeps the name; apps and route are prepared, DNS is not touched", async () => {
    const f = withPilot(["web-staff"]);
    const oldA = { id: "old-a", name: PILOT, type: "A", content: "203.0.113.40", proxied: false, comment: null };
    f.dns[Z_COM]!.push({ ...oldA });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(diags(r, "cloudflare-conflict")).toEqual([]);
    expect(diags(r, "cloudflare-awaiting-cutover")).toEqual([
      `${PILOT}: awaiting cutover (an A record not managed by the tool still holds the name; the Worker's cutover.sh swaps it in place)`,
    ]);
    expect(r.plan.diagnostics.find((d) => d.code === "cloudflare-awaiting-cutover")?.level).toBe("warning");
    const w = f.writes();
    expect(w.some(isAppPost(PILOT))).toBe(true);
    expect(w.some(isTunnelPutWith(T_BLR1, PILOT))).toBe(true);
    expect(w.some(isDnsPost(PILOT))).toBe(false);
    expect(w.some((c) => c.path.endsWith("/dns_records/old-a"))).toBe(false);
    expect(siteDns(f, PILOT)).toEqual([oldA]);

    // Steady state while waiting: no writes.
    let before = f.calls.length;
    await run(f);
    expect(newWrites(f, before)).toEqual([]);

    // Cutover (the old record goes): the next run creates only the CNAME.
    f.dns[Z_COM] = f.dns[Z_COM]!.filter((x) => x.id !== "old-a");
    before = f.calls.length;
    const after = await run(f);
    expect(newWrites(f, before).map((c) => `${c.method} ${c.body?.name ?? c.path}`)).toEqual([`POST ${PILOT}`]);
    expect(applied(after)).toEqual([`create dns-record CNAME ${PILOT}`]);
    expect(siteDns(f, PILOT)[0]).toMatchObject({ type: "CNAME", content: `${T_BLR1}.cfargotunnel.com`, proxied: true });
  });

  it("never touches a manual rule; giving that droplet a site is a conflict with nothing created", async () => {
    const f = exampleFixture();
    const name = "manual-dashboard.example.com";
    f.droplets.push(droplet(43, name, "blr1", "10.0.1.13", ["env-staging", "web-staff"]));
    for (let n = 0; n < 2; n++) {
      const r = await run(f);
      expect(diags(r, "cloudflare-conflict").join("\n")).toMatch(
        new RegExp(`site ${name.replace(/\./g, "\\.")}: tunnel ${T_BLR1} has an ingress rule for ${name.replace(/\./g, "\\.")} that the tool does not own`),
      );
      expect(r.plan.diagnostics.find((d) => d.code === "cloudflare-conflict")?.level).toBe("warning");
      expect(f.tunnels[T_BLR1]!.config?.ingress?.[0]).toEqual(MANUAL_DASHBOARD);
      expect(rules(f, name)).toHaveLength(1);
    }
    expect(f.writes().some(isAppPost(name))).toBe(false);
    expect(f.writes().some(isDnsPost(name))).toBe(false);
  });

  it("fails closed: if the site app cannot be created, no route and no DNS", async () => {
    const f = withPilot(["web-staff"]);
    f.failWhen((c) => (isAppPost(PILOT)(c) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(r.result.failed.map((x) => `${x.op.kind} ${x.op.key}`)).toEqual([`access-app ${PILOT}`]);
    expect(r.result.skipped.map((x) => x.op.key)).toEqual(expect.arrayContaining([`${T_BLR1} ${PILOT}`, `CNAME ${PILOT}`]));
    expect(route(f, PILOT)).toBeUndefined();
    expect(f.writes().some(isDnsPost(PILOT))).toBe(false);
    expect(appAt(f, "ssh-staging-pilot.example.com")).toBeDefined(); // SSH side unaffected
  });

  it("recreates a site app deleted out-of-band; removes the route if that fails", async () => {
    const f = withPilot(["web-staff"]);
    await run(f);
    f.apps = f.apps.filter((a) => a.domain !== PILOT);
    f.failWhen((c) => (isAppPost(PILOT)(c) ? { status: 500 } : undefined));
    const r = await run(f);
    // A warning, not an error: an error would block the very apply that repairs it.
    expect(diags(r, "cloudflare-repair").join("\n")).toMatch(/site route staging-pilot\.example\.com has no "infra-sync: web\.\.\." Access app/);
    expect(r.errors).toEqual([]);
    expect(route(f, PILOT)).toBeUndefined();
    expect(f.tunnels[T_BLR1]!.config?.ingress?.[0]).toEqual(MANUAL_DASHBOARD);
    expect(r.result.applied.find((o) => o.kind === "tunnel-ingress")?.reason).toMatch(/fail closed/);
  });
});

describe("sites: public", () => {
  it("protects /admin only (no whole-host app), then adds route and DNS", async () => {
    const f = withPilot(["web-public"]);
    const r = await run(f);
    expect(r.errors).toEqual([]);
    const w = f.writes();
    expect(w.some(isAppPost(PILOT))).toBe(false);
    const a = idx(w, isAppPost(`${PILOT}/admin`));
    expect(w[a]!.body).toMatchObject({
      name: `infra-sync: web-admin ${PILOT}/admin`,
      allow_authenticate_via_warp: true,
      policies: [{ id: STAFF_POLICY, precedence: 1 }],
    });
    expect(a).toBeLessThan(idx(w, isTunnelPutWith(T_BLR1, PILOT)));
    expect(idx(w, isTunnelPutWith(T_BLR1, PILOT))).toBeLessThan(idx(w, isDnsPost(PILOT)));
    expect(applied(r)).toContain(`create access-app ${PILOT}/admin`);
  });

  it("protected_paths in the file replace /admin", async () => {
    const f = withPilot(["web-public"], { [PILOT]: { protected_paths: ["/manage", "/staff/"] } });
    await run(f);
    expect(appAt(f, `${PILOT}/admin`)).toBeUndefined();
    expect(appAt(f, `${PILOT}/manage`)?.name).toBe(`infra-sync: web-admin ${PILOT}/manage`);
    expect(appAt(f, `${PILOT}/staff/`)?.name).toBe(`infra-sync: web-admin ${PILOT}/staff/`);
    expect(route(f, PILOT)).toBeDefined();
  });

  it("no route while a protected-path app is missing", async () => {
    const f = withPilot(["web-public"], { [PILOT]: { protected_paths: ["/admin", "/staff"] } });
    f.failWhen((c) => (isAppPost(`${PILOT}/staff`)(c) ? { status: 500 } : undefined));
    await run(f);
    expect(appAt(f, `${PILOT}/admin`)).toBeDefined();
    expect(route(f, PILOT)).toBeUndefined();
    expect(siteDns(f, PILOT)).toEqual([]);
  });
});

describe("sites: exceptions and origins", () => {
  it("creates Bypass apps for everyone and for IP ranges; an http origin gets no originRequest", async () => {
    const f = withPilot(["web-staff"], {
      [PILOT]: {
        origin: "http://{ip}:80",
        exceptions: [everyone("/api/webhooks/payments/"), { path: "/payment/internal/", allow: { ips: ["10.0.0.1/32", "198.51.100.206/32"] } }],
      },
    });
    await run(f);
    expect(appAt(f, `${PILOT}/api/webhooks/payments/`)).toMatchObject({
      name: `infra-sync: web-exception ${PILOT}/api/webhooks/payments/`,
      policies: [expect.objectContaining({ name: "infra-sync: web exception", decision: "bypass", include: [{ everyone: {} }], precedence: 1 })],
    });
    expect(appAt(f, `${PILOT}/payment/internal/`)?.policies).toEqual([
      expect.objectContaining({ decision: "bypass", include: [{ ip: { ip: "10.0.0.1/32" } }, { ip: { ip: "198.51.100.206/32" } }] }),
    ]);
    expect(appAt(f, `${PILOT}/api/webhooks/payments/`)?.allow_authenticate_via_warp).toBeUndefined();
    expect(route(f, PILOT)).toEqual({ hostname: PILOT, service: `http://${PILOT_IP}:80` });
  });

  it("creates the exception apps before the whole-host staff app (an already-proxied host never logs in its webhooks)", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { exceptions: [everyone("/heartbeat"), everyone("/otlp")] } });
    await run(f);
    const created = f
      .writes()
      .filter((c) => c.method === "POST" && c.path.endsWith("/access/apps") && c.body?.name?.startsWith("infra-sync: web"))
      .map((c) => c.body.name);
    expect(created).toEqual([`infra-sync: web-exception ${PILOT}/heartbeat`, `infra-sync: web-exception ${PILOT}/otlp`, `infra-sync: web ${PILOT}`]);
    expect(route(f, PILOT)).toBeDefined();
  });

  it("removing an exception from the file deletes its path app, and nothing else", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { exceptions: [everyone("/hooks")] } });
    await run(f);
    const id = appAt(f, `${PILOT}/hooks`)!.id;
    f.sites = { [PILOT]: { exceptions: [] } };
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before).map((c) => `${c.method} ${c.path.replace(/.*\/access\/apps\//, "")}`)).toEqual([`DELETE ${id}`]);
    expect(applied(r)).toEqual([`delete access-app ${PILOT}/hooks`]);
    expect(route(f, PILOT)).toBeDefined();
  });

  it("leaves <droplet>/healthcheck to the deploy target's healthcheck bypass", async () => {
    const f = withPilot(["web-staff", "ci-deploy"], { [PILOT]: { exceptions: [everyone("/healthcheck")] } });
    const r = await run(f);
    expect(r.warnings.join("\n")).toMatch(/staging-pilot\.example\.com\/healthcheck: is the public healthcheck bypass/);
    expect(f.apps.filter((a) => (a.domain ?? "").endsWith("/healthcheck") && a.domain!.startsWith(PILOT)).map((a) => a.name)).toEqual([
      `infra-sync: healthcheck ${PILOT}`,
    ]);
  });
});

describe("sites: exposure changes and removal", () => {
  it("removing the web section keeps every site object and warns", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { exceptions: [everyone("/hooks")] } });
    await run(f);
    retag(f, []);
    const before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before)).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/staging-pilot\.example\.com: no web section but still on the tunnel; to roll back re-add its A record/);
    expect(appAt(f, PILOT)).toBeDefined();
    expect(appAt(f, `${PILOT}/hooks`)).toBeDefined();
    expect(route(f, PILOT)).toBeDefined();
    expect(siteDns(f, PILOT)).toHaveLength(1);
  });

  it("a destroyed droplet's site goes: DNS -> route -> apps, within the one-droplet deletion floor", async () => {
    const f = withPilot(["web-public"], { [PILOT]: { exceptions: [everyone("/a"), everyone("/b")] } });
    await run(f);
    const cnameId = siteDns(f, PILOT)[0]!.id;
    f.droplets = f.droplets.filter((d) => d.name !== PILOT);
    const before = f.calls.length;
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(diags(r, "cloudflare-guard")).toEqual([]);
    const w = newWrites(f, before);
    const iDns = w.findIndex((c) => c.method === "DELETE" && c.path.endsWith(`/dns_records/${cnameId}`));
    const iTun = w.findIndex((c) => c.method === "PUT" && c.path.includes(`/cfd_tunnel/${T_BLR1}/`));
    const appDeletes = w
      .map((c, i) => [c, i] as const)
      .filter(([c]) => c.method === "DELETE" && c.path.includes("/access/apps/"))
      .map(([, i]) => i);
    expect(iDns).toBeGreaterThanOrEqual(0);
    expect(iDns).toBeLessThan(iTun);
    expect(appDeletes.length).toBe(4); // ssh app, /admin, /a, /b
    expect(Math.min(...appDeletes)).toBeGreaterThan(iTun);
    // 5 SSH-side objects + CNAME + route + 3 site apps: more than 6 and > 30% of this small fleet,
    // but all one droplet.
    expect(r.result.applied.filter((o) => o.action === "delete")).toHaveLength(10);
    expect(applied(r)).toEqual(
      expect.arrayContaining([`delete dns-record CNAME ${PILOT}`, `delete tunnel-ingress ${T_BLR1} ${PILOT}`, `delete access-app ${PILOT}/admin`]),
    );
    expect(route(f, PILOT)).toBeUndefined();
    expect(f.apps.some((a) => (a.name ?? "").includes(PILOT))).toBe(false);
    expect(f.tunnels[T_BLR1]!.config?.ingress?.[0]).toEqual(MANUAL_DASHBOARD);
  });

  it("an unreadable zone listing blocks all deletions and that zone's sites", async () => {
    // The tool reads one listing per zone (the Worker read ssh-, vpc- and site listings separately),
    // so a failed listing blocks the SSH route names of that zone too, not just its sites.
    const failListing = (zone: string) => (c: Call) => (c.method === "GET" && c.path.endsWith(`/zones/${zone}/dns_records`) ? { status: 500 } : undefined);

    const f = withPilot(["web-staff"]);
    await run(f);
    f.droplets = f.droplets.filter((d) => d.name !== PILOT);
    f.failWhen(failListing(Z_NET));
    let before = f.calls.length;
    const r = await run(f);
    expect(newWrites(f, before).filter((c) => c.method === "DELETE")).toEqual([]);
    expect(r.errors.join("\n")).toMatch(new RegExp(`${Z_NET} \\(site records\\)`));
    expect(r.plan.ops.filter((o) => o.reason.includes(PILOT) || o.key.includes(PILOT)).every((o) => o.action === "report")).toBe(true);
    expect(r.plan.ops.some((o) => o.action === "report" && o.key === `${T_BLR1} ${PILOT}`)).toBe(true);
    expect(route(f, PILOT)).toBeDefined();

    // A fresh site in the unreadable zone: nothing for the site or its SSH route name; the target is still built.
    const g = exampleFixture();
    g.droplets.push(droplet(44, "new-site.example.com", "nyc1", "10.0.0.44", ["env-prod", "web-staff"]));
    g.failWhen(failListing(Z_COM));
    before = g.calls.length;
    const r2 = await run(g);
    const w = newWrites(g, before);
    expect(w.some(isAppPost("new-site.example.com"))).toBe(false);
    expect(w.some(isDnsPost("new-site.example.com"))).toBe(false);
    expect(route(g, "new-site.example.com", T_NYC1)).toBeUndefined();
    expect(w.some((c) => c.method === "POST" && c.path.endsWith("/infrastructure/targets") && c.body?.hostname === "new-site.example.com")).toBe(true);
    expect(r2.warnings.join("\n")).toMatch(/new-site\.example\.com: site new-site\.example\.com not managed this run: DNS records of zone example\.com unavailable/);
  });

  it("a plan without apply shows the site's app, route and CNAME without writing", async () => {
    const f = withPilot(["web-staff"]);
    const p = await planOnly(f);
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(p.ops.map((o) => `${o.action} ${o.kind} ${o.key}`)).toEqual(
      expect.arrayContaining([`create access-app ${PILOT}`, `create tunnel-ingress ${T_BLR1} ${PILOT}`, `create dns-record CNAME ${PILOT}`]),
    );
  });

  it("a public site with no usable protected path gets nothing (never a route without a login)", async () => {
    const f = withPilot(["web-public", "ci-deploy"], { [PILOT]: { protected_paths: ["/healthcheck"] } });
    const r = await run(f);
    expect(r.warnings.join("\n")).toMatch(/no usable protected path/);
    expect(route(f, PILOT)).toBeUndefined();
    expect(siteDns(f, PILOT)).toEqual([]);
  });

  it("switching staff -> public creates the /admin app before deleting the whole-host app; the route stays", async () => {
    const f = withPilot(["web-staff"]);
    await run(f);
    const hostApp = appAt(f, PILOT)!;
    const routeBefore = structuredClone(route(f, PILOT));
    retag(f, ["web-public"]);
    const before = f.calls.length;
    const r = await run(f);
    const w = newWrites(f, before);
    const iCreate = idx(w, isAppPost(`${PILOT}/admin`));
    const iDelete = idx(w, isAppDelete(hostApp.id));
    expect(iCreate).toBeGreaterThanOrEqual(0);
    expect(iCreate).toBeLessThan(iDelete);
    expect(w.some((c) => c.path.includes("/cfd_tunnel/"))).toBe(false);
    expect(route(f, PILOT)).toEqual(routeBefore);
    expect(appAt(f, PILOT)).toBeUndefined();
    expect(r.errors).toEqual([]);

    // And back: public -> staff.
    const adminApp = appAt(f, `${PILOT}/admin`)!;
    retag(f, ["web-staff"]);
    const b2 = f.calls.length;
    await run(f);
    const w2 = newWrites(f, b2);
    expect(idx(w2, isAppPost(PILOT))).toBeLessThan(idx(w2, isAppDelete(adminApp.id)));
    expect(appAt(f, `${PILOT}/admin`)).toBeUndefined();
  });

  it("a failed switch keeps the old app and the route", async () => {
    const f = withPilot(["web-staff"]);
    await run(f);
    retag(f, ["web-public"]);
    f.failWhen((c) => (isAppPost(`${PILOT}/admin`)(c) ? { status: 500 } : undefined));
    const r = await run(f);
    expect(appAt(f, PILOT)).toBeDefined();
    expect(route(f, PILOT)).toBeDefined();
    expect(r.result.skipped.find((x) => x.op.kind === "access-app" && x.op.key === PILOT)?.reason).toMatch(
      new RegExp(`access-app ${PILOT.replace(/\./g, "\\.")}/admin did not succeed`),
    );
  });

  it("moves the route to the new region's tunnel and repoints the CNAME", async () => {
    const f = withPilot(["web-staff"]);
    await run(f);
    retag(f, ["web-staff"], "nyc1", "10.0.0.40");
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    expect(route(f, PILOT, T_BLR1)).toBeUndefined();
    expect(route(f, PILOT, T_NYC1)).toEqual({ hostname: PILOT, service: "https://10.0.0.40:443", originRequest: { noTLSVerify: true } });
    expect(siteDns(f, PILOT)[0]!.content).toBe(`${T_NYC1}.cfargotunnel.com`);
    expect(op(r, "tunnel-ingress", `${T_BLR1} ${PILOT}`)?.action).toBe("delete");
    expect(applied(r)).toContain(`delete tunnel-ingress ${T_BLR1} ${PILOT}`);
  });
});

// ---------- public extra hostnames: 404 for protected paths, no Access app ----------

const EXTRA = "pilot-brand.example.net"; // Z_NET
const EXTRA2 = "pilot-b.example.com";
const notFound = (host: string, path = "^/admin(/.*)?$") => ({ hostname: host, path, service: "http_status:404" });
const httpMain = (host: string, ip = PILOT_IP) => ({ hostname: host, service: `http://${ip}:80` });
const httpsMain = (host: string, ip = PILOT_IP) => ({ hostname: host, service: `https://${ip}:443`, originRequest: { noTLSVerify: true } });
const oldAdminId = (h: string, p = "/admin") => `old-admin-${h}${p.replace(/\//g, "_")}`;
/** The state before 404 rules: a web-admin app per protected path of each extra hostname, and a single route rule. */
function toOldState(f: FakeCloudflare, hosts: string[], paths = ["/admin"]) {
  for (const h of hosts) {
    for (const p of paths) {
      f.apps.push({
        id: oldAdminId(h, p),
        name: `infra-sync: web-admin ${h}${p}`,
        type: "self_hosted",
        domain: `${h}${p}`,
        app_launcher_visible: false,
        session_duration: "24h",
        allow_authenticate_via_warp: true,
        policies: [{ ...structuredClone(f.reusablePolicies[STAFF_POLICY]), precedence: 1 }],
      });
    }
  }
  const set = new Set(hosts);
  for (const t of Object.values(f.tunnels)) {
    if (t.config?.ingress) t.config.ingress = t.config.ingress.filter((r) => !(set.has(r.hostname ?? "") && r.path));
  }
}

describe("sites: public extra hostnames (404 instead of the staff login)", () => {
  const sites = (over: SiteCfg = {}): Record<string, SiteCfg> => ({
    [PILOT]: { origin: "http://{ip}:80", hostnames: [EXTRA], exceptions: [everyone("/api/webhooks/payments/")], ...over },
  });
  /** Warnings other than the fixture's unrelated "skipped" one. */
  const otherWarnings = (r: RunResult) => r.plan.diagnostics.filter((d) => d.level === "warning" && d.code !== "cloudflare-skipped").map((d) => d.message);

  it("the droplet's own name gets the web-admin app; extra hostnames get [404 rule, route] and only their exception apps", async () => {
    const f = withPilot(["web-public"], sites());
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(otherWarnings(r)).toEqual([]);

    // Base name: staff login on /admin, single route.
    expect(appAt(f, `${PILOT}/admin`)?.name).toBe(`infra-sync: web-admin ${PILOT}/admin`);
    expect(rules(f, PILOT)).toEqual([httpMain(PILOT)]);
    // Extra hostname: no web-admin app; the exception still gets its Bypass app.
    expect(f.apps.filter((a) => (a.domain ?? "").startsWith(EXTRA)).map((a) => a.name)).toEqual([`infra-sync: web-exception ${EXTRA}/api/webhooks/payments/`]);
    expect(f.writes().some((c) => (c.body?.name ?? "").startsWith(`infra-sync: web-admin ${EXTRA}`))).toBe(false);

    // The group: 404 path rule immediately before the main rule; manual rule first, catch-all last.
    const ing = f.tunnels[T_BLR1]!.config!.ingress!;
    const at = ing.findIndex((x) => x.hostname === EXTRA);
    expect(ing.slice(at, at + 2)).toEqual([notFound(EXTRA), httpMain(EXTRA)]);
    expect(rules(f, EXTRA)).toHaveLength(2);
    expect(ing[0]).toEqual(MANUAL_DASHBOARD);
    expect(ing.at(-1)).toEqual({ service: "http_status:404" });

    // Route before CNAME; the route is one op (the whole group).
    const w = f.writes();
    expect(idx(w, isTunnelPutWith(T_BLR1, EXTRA))).toBeLessThan(idx(w, isDnsPost(EXTRA)));
    expect(siteDns(f, EXTRA, Z_NET)).toHaveLength(1);
    expect(applied(r).filter((x) => x.includes(`tunnel-ingress ${T_BLR1} ${EXTRA}`))).toEqual([`create tunnel-ingress ${T_BLR1} ${EXTRA}`]);
    expect((op(r, "tunnel-ingress", `${T_BLR1} ${EXTRA}`)?.after as { rules: IngressRule[] }).rules).toEqual([notFound(EXTRA), httpMain(EXTRA)]);
  });

  it("protected_paths: one 404 rule per path on extra hostnames, regex metacharacters escaped; apps only on the droplet's own name", async () => {
    const f = withPilot(["web-public"], { [PILOT]: { hostnames: [EXTRA], protected_paths: ["/manage", "/staff/", "/v1.0/(beta)+"] } });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(rules(f, EXTRA)).toEqual([notFound(EXTRA, "^/manage(/.*)?$"), notFound(EXTRA, "^/staff(/.*)?$"), notFound(EXTRA, "^/v1\\.0/\\(beta\\)\\+(/.*)?$"), httpsMain(EXTRA)]);
    expect(rules(f, PILOT)).toEqual([httpsMain(PILOT)]);
    expect(
      f.apps
        .filter((a) => (a.name ?? "").startsWith("infra-sync: web-admin"))
        .map((a) => a.domain)
        .sort(),
    ).toEqual([`${PILOT}/manage`, `${PILOT}/staff/`, `${PILOT}/v1.0/(beta)+`].sort());
  });

  it("migration: rewrites the old single routes into groups in place, then deletes the old web-admin apps", async () => {
    const f = withPilot(["web-public"], sites({ hostnames: [EXTRA, EXTRA2] }));
    await run(f);
    toOldState(f, [EXTRA, EXTRA2]);
    const oldIngress = structuredClone(f.tunnels[T_BLR1]!.config!.ingress!);
    const before = f.calls.length;
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(diags(r, "cloudflare-conflict")).toEqual([]);
    expect(writeLines(newWrites(f, before))).toEqual([
      `PUT /cfd_tunnel/${T_BLR1}/configurations`,
      `DELETE /access/apps/${oldAdminId(EXTRA)}`,
      `DELETE /access/apps/${oldAdminId(EXTRA2)}`,
    ]);
    // Each group sits where the old single rule was; everything else is unchanged.
    const expected = oldIngress.flatMap((x) => (x.hostname === EXTRA || x.hostname === EXTRA2 ? [notFound(x.hostname), x] : [x]));
    expect(f.tunnels[T_BLR1]!.config!.ingress).toEqual(expected);
    expect(applied(r).filter((x) => x.startsWith("update tunnel-ingress")).sort()).toEqual(
      [`update tunnel-ingress ${T_BLR1} ${EXTRA2}`, `update tunnel-ingress ${T_BLR1} ${EXTRA}`].sort(),
    );
    expect(applied(r).filter((x) => x.startsWith("delete")).sort()).toEqual([`delete access-app ${EXTRA2}/admin`, `delete access-app ${EXTRA}/admin`].sort());
    expect(appAt(f, `${PILOT}/admin`)).toBeDefined();

    // Then steady: no writes, and no "lost its Access app" warning for the app-less brand routes.
    const b2 = f.calls.length;
    const again = await run(f);
    expect(newWrites(f, b2)).toEqual([]);
    expect(again.errors).toEqual([]);
    expect(diags(again, "cloudflare-repair")).toEqual([]);
  });

  it("migration: if the tunnel PUT fails, the old web-admin apps are kept; the next run finishes the job", async () => {
    const f = withPilot(["web-public"], sites());
    await run(f);
    toOldState(f, [EXTRA]);
    f.failWhen((c) => (c.method === "PUT" && c.path.includes(`/cfd_tunnel/${T_BLR1}/`) ? { status: 500 } : undefined));
    let before = f.calls.length;
    const failed = await run(f);
    expect(newWrites(f, before).filter((c) => c.method === "DELETE")).toEqual([]);
    expect(appAt(f, `${EXTRA}/admin`)).toBeDefined();
    expect(rules(f, EXTRA)).toEqual([httpMain(EXTRA)]);
    expect(failed.result.failed.map((x) => x.error).join("\n")).toMatch(new RegExp(`tunnel ${T_BLR1} configuration: .*HTTP 500`));
    expect(failed.result.skipped.find((s) => s.op.key === `${EXTRA}/admin`)?.reason).toMatch(new RegExp(`tunnel-ingress ${T_BLR1} ${EXTRA.replace(/\./g, "\\.")} did not succeed`));

    f.failers = [];
    before = f.calls.length;
    const ok = await run(f);
    expect(ok.result.failed).toEqual([]);
    expect(writeLines(newWrites(f, before))).toEqual([`PUT /cfd_tunnel/${T_BLR1}/configurations`, `DELETE /access/apps/${oldAdminId(EXTRA)}`]);
    expect(rules(f, EXTRA)).toEqual([notFound(EXTRA), httpMain(EXTRA)]);
  });

  it("ownership by declaration: a route for a declared hostname with no app or marked DNS is updated, not a conflict; a manual rule for the base name still conflicts", async () => {
    const cfg = { [PILOT]: { hostnames: [EXTRA] } };
    const f = withPilot(["web-public"], cfg);
    f.tunnels[T_BLR1]!.config!.ingress!.splice(1, 0, { hostname: EXTRA, service: "http://10.0.1.99:80" }); // e.g. added by hand
    const r = await run(f);
    expect(diags(r, "cloudflare-conflict")).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(f.tunnels[T_BLR1]!.config!.ingress!.slice(0, 3)).toEqual([MANUAL_DASHBOARD, notFound(EXTRA), httpsMain(EXTRA)]);
    expect(applied(r)).toContain(`update tunnel-ingress ${T_BLR1} ${EXTRA}`);

    // The droplet's own name is never owned by declaration.
    const g = withPilot(["web-public"], cfg);
    g.tunnels[T_BLR1]!.config!.ingress!.splice(1, 0, { hostname: PILOT, service: "http://10.0.1.99:80" });
    const r2 = await run(g);
    expect(diags(r2, "cloudflare-conflict").join("\n")).toMatch(
      new RegExp(`site ${PILOT.replace(/\./g, "\\.")}: tunnel ${T_BLR1} has an ingress rule for ${PILOT.replace(/\./g, "\\.")} that the tool does not own`),
    );
    expect(rules(g, PILOT)).toEqual([{ hostname: PILOT, service: "http://10.0.1.99:80" }]);
    expect(g.writes().some(isAppPost(`${PILOT}/admin`))).toBe(false);
    expect(rules(g, EXTRA)).toEqual([notFound(EXTRA), httpsMain(EXTRA)]); // the extra hostname is still built

    // Only for a droplet with a site: without one, a rule for the listed name is left alone.
    const u = withPilot([], cfg);
    u.tunnels[T_BLR1]!.config!.ingress!.splice(1, 0, { hostname: EXTRA, service: "http://10.0.1.99:80" });
    const ur = await run(u);
    expect(diags(ur, "cloudflare-conflict")).toEqual([]);
    expect(rules(u, EXTRA)).toEqual([{ hostname: EXTRA, service: "http://10.0.1.99:80" }]);
  });

  it("pre-cutover: a foreign A record holds the brand name; the route group is created without DNS, then the CNAME after the record goes", async () => {
    const f = withPilot(["web-public"], sites());
    f.dns[Z_NET]!.push({ id: "brand-a", name: EXTRA, type: "A", content: "203.0.113.40", proxied: true, comment: null });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(diags(r, "cloudflare-conflict")).toEqual([]);
    expect(otherWarnings(r)).toEqual([`${EXTRA}: awaiting cutover (an A record not managed by the tool still holds the name; the Worker's cutover.sh swaps it in place)`]);
    expect(rules(f, EXTRA)).toEqual([notFound(EXTRA), httpMain(EXTRA)]);
    expect(f.writes().some(isDnsPost(EXTRA))).toBe(false);

    let before = f.calls.length;
    await run(f);
    expect(newWrites(f, before)).toEqual([]);

    f.dns[Z_NET] = f.dns[Z_NET]!.filter((x) => x.id !== "brand-a");
    before = f.calls.length;
    const after = await run(f);
    expect(newWrites(f, before).map((c) => `${c.method} ${c.body?.name ?? c.path}`)).toEqual([`POST ${EXTRA}`]);
    expect(applied(after)).toEqual([`create dns-record CNAME ${EXTRA}`]);
  });

  it("a declared hostname removed from the file: with a marked CNAME it is deleted (CNAME -> route group); without one it is kept, with a warning", async () => {
    // Post-cutover: the CNAME proves ownership.
    const f = withPilot(["web-public"], { [PILOT]: { hostnames: [EXTRA] } });
    await run(f);
    const cname = siteDns(f, EXTRA, Z_NET)[0]!.id;
    f.sites = { [PILOT]: {} };
    const before = f.calls.length;
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(writeLines(newWrites(f, before))).toEqual([`DELETE /zones/${Z_NET}/dns_records/${cname}`, `PUT /cfd_tunnel/${T_BLR1}/configurations`]);
    expect(rules(f, EXTRA)).toEqual([]);
    expect(applied(r)).toEqual([`delete dns-record CNAME ${EXTRA}`, `delete tunnel-ingress ${T_BLR1} ${EXTRA}`]);

    // Pre-cutover: nothing proves ownership any more; the route stays and the run warns.
    const g = withPilot(["web-public"], { [PILOT]: { hostnames: [EXTRA] } });
    g.dns[Z_NET]!.push({ id: "brand-a", name: EXTRA, type: "A", content: "203.0.113.40", proxied: true, comment: null });
    await run(g);
    g.sites = { [PILOT]: {} };
    const b2 = g.calls.length;
    const r2 = await run(g);
    expect(newWrites(g, b2)).toEqual([]);
    expect(r2.errors).toEqual([]);
    expect(rules(g, EXTRA)).toEqual([notFound(EXTRA), httpsMain(EXTRA)]);
    expect(r2.warnings.join("\n")).toMatch(
      new RegExp(`${EXTRA.replace(/\./g, "\\.")}: tunnel ${T_BLR1} has a route with 404 rules for protected paths, but the tool can no longer prove it owns it`),
    );
  });

  it("staff extra hostnames are unchanged: whole-host app, single route", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { hostnames: [EXTRA] } });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(appAt(f, EXTRA)?.name).toBe(`infra-sync: web ${EXTRA}`);
    expect(rules(f, EXTRA)).toEqual([httpsMain(EXTRA)]);
  });

  it("switching an extra hostname staff -> public: 404 rules go live before the whole-host app is deleted; and back", async () => {
    const f = withPilot(["web-staff"], { [PILOT]: { hostnames: [EXTRA] } });
    await run(f);
    const hostApp = appAt(f, EXTRA)!;
    retag(f, ["web-public"]);
    let before = f.calls.length;
    let r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    let w = newWrites(f, before);
    expect(idx(w, isTunnelPutWith(T_BLR1, EXTRA))).toBeLessThan(idx(w, isAppDelete(hostApp.id)));
    expect(rules(f, EXTRA)).toEqual([notFound(EXTRA), httpsMain(EXTRA)]);
    expect(appAt(f, EXTRA)).toBeUndefined();

    // Back to staff: the whole-host app comes first, then the route loses its 404 rules.
    retag(f, ["web-staff"]);
    before = f.calls.length;
    r = await run(f);
    expect(r.errors).toEqual([]);
    w = newWrites(f, before);
    expect(idx(w, isAppPost(EXTRA))).toBeLessThan(idx(w, (c) => c.method === "PUT" && c.path.includes(`/cfd_tunnel/${T_BLR1}/`)));
    expect(rules(f, EXTRA)).toEqual([httpsMain(EXTRA)]);
  });

  it("is idempotent: staff and public sites with extra hostnames, protected paths and exceptions", async () => {
    const f = withPilot(["web-public"], {
      [PILOT]: { hostnames: [EXTRA, EXTRA2], protected_paths: ["/admin", "/v1.0/(beta)+"], exceptions: [everyone("/hooks")] },
      "shop.example.com": { origin: "http://{ip}:80", hostnames: ["shop-brand.example.net"] },
    });
    f.droplets.push(droplet(41, "shop.example.com", "nyc1", "10.0.0.41", ["env-prod", "web-staff"]));
    const first = await run(f);
    expect(first.errors).toEqual([]);
    expect(first.result.failed).toEqual([]);
    const before = f.calls.length;
    const second = await run(f);
    expect(newWrites(f, before)).toEqual([]);
    expect(changes(second.plan)).toEqual([]);
    expect([...second.errors, ...otherWarnings(second)]).toEqual([]);
  });
});
