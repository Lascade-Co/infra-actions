// Guard rail 1 (names that point at a site), ported from the infra-sync Worker's
// test/guardrails.test.ts. Only what the plan and apply do: the Worker's cutover, health watch and
// Telegram parts are not ported. Fake data only.

import { describe, expect, it } from "vitest";
import { findDependents } from "../../src/cloudflare/dependents.js";
import type { DnsRecord } from "../../src/cloudflare/types.js";
import type { ModulePlan } from "../../src/core/plan.js";
import { changes, droplet, exampleFixture, FakeCloudflare, planOnly, run, T_BLR1, T_NYC1, Z_COM, Z_NET, Z_ORG } from "./fake.js";

const PILOT = "staging-pilot.example.com";
const PILOT_IP = "10.0.1.40";
const PILOT_PUBLIC = "203.0.113.40"; // droplet(40, ...)'s public IPv4 in the fake
const BRAND = "pilot-brand.example.net";

const pilot = (tags: string[]) => droplet(40, PILOT, "blr1", PILOT_IP, ["env-staging", ...tags]);
const rec = (id: string, name: string, type: string, content: string, proxied = true): DnsRecord => ({ id, name, type, content, proxied, ttl: 1, comment: null });
const cname = (id: string, name: string, content: string, proxied = true) => rec(id, name, "CNAME", content, proxied);

/** The example fixture plus the pilot site, still on its old proxied A record (awaiting cutover). */
function fixture(tags = ["web-public"]): FakeCloudflare {
  const f = exampleFixture();
  f.droplets.push(pilot(tags));
  f.dns[Z_COM]!.push(rec("pilot-a", PILOT, "A", PILOT_PUBLIC));
  return f;
}
const rulesFor = (f: FakeCloudflare, host: string, tid = T_BLR1) => (f.tunnels[tid]!.config?.ingress ?? []).filter((r) => r.hostname === host);
const dnsAt = (f: FakeCloudflare, name: string) => Object.values(f.dns).flat().filter((r) => r.name === name);
const notFound = (host: string) => ({ hostname: host, path: "^/admin(/.*)?$", service: "http_status:404" });
const httpsMain = (host: string) => ({ hostname: host, service: `https://${PILOT_IP}:443`, originRequest: { noTLSVerify: true } });
const byCode = (p: ModulePlan, code: string, level?: string) => p.diagnostics.filter((d) => d.code === code && (!level || d.level === level)).map((d) => d.message);
const errors = (p: ModulePlan) => p.diagnostics.filter((d) => d.level === "error").map((d) => d.message);
const conflicts = (p: ModulePlan) => byCode(p, "cloudflare-conflict");

describe("guard rail 1: dependents are found and covered by the plan", () => {
  it("a proxied CNAME to a public site gets the site's route with 404 rules before any cutover; its own record is left alone", async () => {
    const f = fixture(["web-public"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, PILOT));
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(conflicts(r.plan)).toEqual([]);
    expect(r.result.failed).toEqual([]);
    // Only the pilot's own record is "awaiting cutover"; the dependent's CNAME stays as it is.
    expect(byCode(r.plan, "cloudflare-awaiting-cutover")).toEqual([expect.stringMatching(new RegExp(`^${PILOT}: awaiting cutover `))]);
    expect(rulesFor(f, BRAND)).toEqual([notFound(BRAND), httpsMain(BRAND)]);
    expect(f.writes().some((c) => c.path.includes("dns_records") && c.body?.name === BRAND)).toBe(false);
    expect(dnsAt(f, BRAND)).toEqual([cname("brand-c", BRAND, PILOT)]);
    expect(f.apps.some((a) => (a.domain ?? "").startsWith(BRAND))).toBe(false); // public brand: 404 rules, no login
    // An ok dependent is not a diagnostic.
    expect(byCode(r.plan, "cloudflare-dependent")).toEqual([]);
    expect(r.plan.ops).toContainEqual(expect.objectContaining({ kind: "tunnel-ingress", key: `${T_BLR1} ${BRAND}`, action: "create", droplet: PILOT }));
    // The implicit hostname has no DNS op of its own.
    expect(r.plan.ops.some((o) => o.kind === "dns-record" && o.key.endsWith(BRAND))).toBe(false);

    // Idempotent: its own route is not foreign on the next run, and nothing changes.
    const again = await planOnly(f);
    expect(changes(again)).toEqual([]);
    expect(errors(again)).toEqual([]);
    expect(conflicts(again)).toEqual([]);
  });

  it("a proxied CNAME to a staff site gets the whole-host staff app, then the route", async () => {
    const f = fixture(["web-staff"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, `${PILOT.toUpperCase()}.`)); // trailing dot, any case
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(f.apps.find((a) => a.domain === BRAND)?.name).toBe(`infra-sync: web ${BRAND}`);
    expect(rulesFor(f, BRAND)).toEqual([httpsMain(BRAND)]);
    const w = f.writes();
    expect(w.findIndex((c) => c.method === "POST" && c.body?.domain === BRAND)).toBeLessThan(
      w.findIndex((c) => c.method === "PUT" && c.body?.config?.ingress?.some((x: any) => x.hostname === BRAND)),
    );
  });

  it("follows CNAME chains (X → Y → site) and stops at names outside the account and at loops", async () => {
    const f = fixture(["web-public"]);
    const MID = "pilot-mid.example.org";
    const TOP = "pilot-top.example.net";
    f.dns[Z_ORG]!.push(cname("mid", MID, PILOT));
    f.dns[Z_NET]!.push(cname("top", TOP, MID));
    f.dns[Z_NET]!.push(cname("ext", "ext.example.net", "foo.outside.test"));
    f.dns[Z_NET]!.push(cname("l1", "loop-a.example.net", "loop-b.example.net"));
    f.dns[Z_NET]!.push(cname("l2", "loop-b.example.net", "loop-a.example.net"));
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(rulesFor(f, TOP)).toEqual([notFound(TOP), httpsMain(TOP)]);
    expect(rulesFor(f, MID)).toEqual([notFound(MID), httpsMain(MID)]);
    for (const h of ["ext.example.net", "loop-a.example.net", "loop-b.example.net"]) expect(rulesFor(f, h)).toEqual([]);
    // The pure scan behind it: MID directly, TOP via MID.
    const records = Object.entries(f.dns).flatMap(([zoneId, rs]) => rs.map((record) => ({ zoneId, record })));
    const scan = findDependents(records, [{ site: PILOT, hosts: [PILOT], publicIps: [PILOT_PUBLIC] }], ["example.com", "example.net", "example.org"], new Set([PILOT]));
    expect(scan.dependents.map((d) => [d.name, d.kind, d.via])).toEqual([
      [MID, "implicit", []],
      [TOP, "implicit", [MID]],
    ]);
  });

  it("a DNS-only CNAME to a site is an error, and gets nothing", async () => {
    const f = fixture(["web-public"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, PILOT, false));
    const r = await run(f, { apply: false });
    expect(r.errors).toEqual([expect.stringMatching(new RegExp(`^${PILOT}: dependent ${BRAND} \\(DNS-only CNAME → ${PILOT}\\) is DNS-only: .*stops working`))]);
    expect(r.plan.diagnostics.find((d) => d.code === "cloudflare-dependent")).toMatchObject({ level: "error", droplet: PILOT, file: `droplets/${PILOT}.yaml` });
    expect(r.plan.ops.some((o) => o.key.endsWith(BRAND))).toBe(false);
  });

  it("an A record to the droplet's public IP under another name is a warning (no action); the site's own names are not", async () => {
    const f = fixture(["web-public"]);
    const DIRECT = "pilot-direct.example.org";
    f.dns[Z_ORG]!.push(rec("direct", DIRECT, "A", PILOT_PUBLIC));
    f.dns[Z_NET]!.push(rec("declared-a", BRAND, "A", PILOT_PUBLIC)); // declared below: awaiting cutover, not a dependent
    f.sites[PILOT] = { hostnames: [BRAND] };
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(byCode(r.plan, "cloudflare-dependent", "warning")).toEqual([
      `${PILOT}: dependent ${DIRECT} (A ${PILOT_PUBLIC}, proxied) goes straight to ${PILOT}'s public IP (direct to origin); it breaks when Phase 5 closes the origin ports. Add it to ${PILOT}'s web.hostnames`,
    ]);
    expect(rulesFor(f, DIRECT)).toEqual([]);
    expect(f.writes().some((c) => JSON.stringify(c.body ?? {}).includes(DIRECT))).toBe(false);
  });

  it("a multi-level dependent (no certificate) is an error naming it, never silently skipped; so is another droplet's name", async () => {
    const f = fixture(["web-public"]);
    f.dns[Z_NET]!.push(cname("deep", "a.b.example.net", PILOT));
    f.dns[Z_COM]!.push(cname("click", "click.example.com", PILOT)); // a droplet's own name
    const r = await run(f, { apply: false });
    expect(byCode(r.plan, "cloudflare-dependent", "error")).toEqual([
      expect.stringMatching(/^staging-pilot\.example\.com: dependent a\.b\.example\.net \(proxied CNAME → staging-pilot\.example\.com\) can't be served .*more than one level under example\.net/),
      expect.stringMatching(/^staging-pilot\.example\.com: dependent click\.example\.com .*another droplet's own name/),
    ]);
    expect(r.plan.ops.some((o) => o.key.endsWith("a.b.example.net"))).toBe(false);
  });

  it("a DNS-only wildcard in a zone with a site or dependent name is a warning", async () => {
    const f = fixture(["web-public"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, PILOT));
    f.dns[Z_NET]!.push(rec("wild", "*.example.net", "A", "198.51.100.95", false));
    f.dns[Z_ORG]!.push(rec("wild2", "*.example.org", "A", "198.51.100.96", false)); // no site name there
    f.dns[Z_COM]!.push(rec("wild3", "*.example.com", "A", "198.51.100.97", true)); // proxied: not a gap risk
    const r = await run(f, { apply: false });
    expect(byCode(r.plan, "cloudflare-wildcard")).toEqual([
      `*.example.net: DNS-only wildcard (A 198.51.100.95) in a zone with site or dependent names (${BRAND}); whenever one of them has no record of its own, the wildcard answers for it. Only swap records in place (cutover), never delete-then-create`,
    ]);
    expect(r.plan.diagnostics.find((d) => d.code === "cloudflare-wildcard")?.level).toBe("warning");
  });

  it("a declared hostname that is a CNAME to the base keeps its own plan (awaiting cutover), with no dependent diagnostic", async () => {
    const f = fixture(["web-public"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, PILOT));
    f.sites[PILOT] = { hostnames: [BRAND] };
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(byCode(r.plan, "cloudflare-dependent")).toEqual([]);
    expect(byCode(r.plan, "cloudflare-awaiting-cutover")).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${BRAND}: awaiting cutover`))]));
    expect(rulesFor(f, BRAND)).toEqual([notFound(BRAND), httpsMain(BRAND)]);
    expect(dnsAt(f, BRAND)).toEqual([cname("brand-c", BRAND, PILOT)]);
  });

  it("keep rule: removing the web section keeps an implicit hostname's app and route (staff), with a warning", async () => {
    const f = fixture(["web-staff"]);
    f.dns[Z_NET]!.push(cname("brand-c", BRAND, PILOT));
    await run(f);
    expect(f.apps.find((a) => a.domain === BRAND)).toBeDefined();
    f.droplets = f.droplets.map((d) => (d.name === PILOT ? pilot([]) : d));
    const before = f.calls.length;
    const r = await run(f);
    expect(f.calls.slice(before).filter((c) => c.method === "DELETE")).toEqual([]);
    expect(r.plan.ops.filter((o) => o.action === "delete" || o.action === "report")).toEqual([]);
    expect(rulesFor(f, BRAND)).toEqual([httpsMain(BRAND)]);
    expect(f.apps.find((a) => a.domain === BRAND)).toBeDefined();
    expect(r.warnings).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^${BRAND}: no web section; its "infra-sync: web..." Access apps and tunnel route are kept`))]));
  });

  it("findDependents (pure): a name claimed by two sites has no dependents; marked records are never dependents", () => {
    const recs = [
      { zoneId: "z", record: cname("1", "x.example.com", "shared.example.com") },
      { zoneId: "z", record: { ...cname("2", "y.example.com", "a.example.com"), comment: "managed-by:infra-sync" } },
    ];
    const scan = findDependents(
      recs,
      [
        { site: "a.example.com", hosts: ["a.example.com", "shared.example.com"], publicIps: [] },
        { site: "b.example.com", hosts: ["b.example.com", "shared.example.com"], publicIps: [] },
      ],
      ["example.com"],
      new Set(["a.example.com", "b.example.com"]),
    );
    expect(scan.dependents).toEqual([]);
  });
});

describe("replay of a brand-domain outage: a brand CNAME to a public site", () => {
  const CAR = "car.example.com";
  const CAR_BRAND = "car.example.net";
  function carFixture() {
    const f = new FakeCloudflare();
    f.droplets = [droplet(70, CAR, "nyc1", "10.0.0.70", ["env-prod", "web-public"]), droplet(71, "other.example.com", "nyc1", "10.0.0.71", ["env-prod"])];
    f.sites[CAR] = { origin: "http://{ip}:80" }; // as before the outage: no extra hostnames in the file
    f.dns[Z_COM]!.push(rec("car-a", CAR, "A", "203.0.113.70"));
    f.dns[Z_NET]!.push(cname("car-brand", CAR_BRAND, CAR));
    return f;
  }
  const brandRoute = [
    { hostname: CAR_BRAND, path: "^/admin(/.*)?$", service: "http_status:404" },
    { hostname: CAR_BRAND, service: "http://10.0.0.70:80" },
  ];

  it("the brand name gets its own route before the base site's cutover; a lost brand route is put back; the swapped site plans no change", async () => {
    const f = carFixture();
    const first = await run(f);
    expect(first.errors).toEqual([]);
    expect(first.result.failed).toEqual([]);
    // Before any cutover: the brand name has its own route (404 rule for /admin, then the origin).
    expect(rulesFor(f, CAR_BRAND, T_NYC1)).toEqual(brandRoute);

    // The state at the time of the outage: the base site had a route and the brand didn't. The next run puts it back.
    f.tunnels[T_NYC1]!.config!.ingress = f.tunnels[T_NYC1]!.config!.ingress!.filter((r) => r.hostname !== CAR_BRAND);
    const second = await run(f);
    expect(second.plan.ops.filter((o) => o.action !== "report").map((o) => `${o.action} ${o.kind} ${o.key}`)).toEqual([`create tunnel-ingress ${T_NYC1} ${CAR_BRAND}`]);
    expect(rulesFor(f, CAR_BRAND, T_NYC1)).toEqual(brandRoute);

    // The Worker's cutover swaps the base A record in place to the marked tunnel CNAME; after it the
    // plan changes nothing (the brand's record stays its own CNAME).
    const i = f.dns[Z_COM]!.findIndex((r) => r.id === "car-a");
    f.dns[Z_COM]![i] = { id: "car-a", name: CAR, type: "CNAME", content: `${T_NYC1}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "managed-by:infra-sync" };
    const after = await planOnly(f);
    expect(changes(after)).toEqual([]);
    expect(errors(after)).toEqual([]);
    expect(dnsAt(f, CAR_BRAND)).toEqual([cname("car-brand", CAR_BRAND, CAR)]);
  });
});
