// Web access rules (decision 19): web.access who-lists -> Access apps, 404 rules on extra hostnames,
// the public /healthcheck/, and who-lists in ssh: (tokens on the ssh- app only, staff). Each row of
// the mapping is checked against the bodies the fake receives. Everything here is fake.

import { describe, expect, it } from "vitest";
import { ADMINS, droplet, ETL_TOKEN, FakeCloudflare, idx, isAppPost, planOnly, run, STAFF_POLICY, T_NYC1, testAccount, UPTIME_TOKEN, changes } from "./fake.js";
import type { AccountConfig } from "../../src/core/model.js";

const SITE = "shop.example.com";
const EXTRA = "shop.example.net";
const IP = "10.0.0.41";
const DEV = "dev@example.com";

function account(): AccountConfig {
  return { ...testAccount(), groups: { admins: [...ADMINS], devs: [DEV] } };
}

/** One droplet with a site whose web section is `web` (written as in a droplet file). */
function site(web: Record<string, unknown>, ssh?: string[]): FakeCloudflare {
  const f = new FakeCloudflare();
  f.droplets = [droplet(41, SITE, "nyc1", IP, ["env-prod"])];
  f.web[SITE] = web;
  if (ssh) f.ssh[SITE] = ssh;
  return f;
}

const appAt = (f: FakeCloudflare, domain: string) => f.apps.find((a) => a.domain === domain);
/** The policies as the fake stores them: reusable ones by id, inline ones by name/decision/include. */
const policiesOf = (f: FakeCloudflare, domain: string) =>
  (appAt(f, domain)?.policies ?? [])
    .slice()
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((p) => (p.reusable ? { reusable: p.id } : { name: p.name, decision: p.decision, include: p.include }));
const rulesOf = (f: FakeCloudflare, host: string) => (f.tunnels[T_NYC1]!.config?.ingress ?? []).filter((r) => r.hostname === host);

describe("web.access -> Access apps (one row of the mapping each)", () => {
  it('"/": [everyone] puts no app on the root; "/admin": [staff] is the web-admin app with the reusable staff policy', async () => {
    const f = site({ access: { "/": ["everyone"], "/admin": ["staff"] } });
    const r = await run(f, { account: account() });
    expect(r.errors).toEqual([]);
    expect(appAt(f, SITE)).toBeUndefined();
    const admin = appAt(f, `${SITE}/admin`)!;
    expect(admin).toMatchObject({ name: `infra-sync: web-admin ${SITE}/admin`, allow_authenticate_via_warp: true, session_duration: "24h" });
    expect(policiesOf(f, `${SITE}/admin`)).toEqual([{ reusable: STAFF_POLICY }]);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it('"/": [staff] is the whole-site app, as the Worker built it for web-staff', async () => {
    const f = site({ access: { "/": ["staff"] } });
    await run(f, { account: account() });
    expect(appAt(f, SITE)).toMatchObject({ name: `infra-sync: web ${SITE}`, allow_authenticate_via_warp: true, app_launcher_visible: false });
    expect(policiesOf(f, SITE)).toEqual([{ reusable: STAFF_POLICY }]);
  });

  it("everyone on a path is a Bypass app; IPs a Bypass by IP; tokens Service Auth (web-exception apps)", async () => {
    const f = site({
      access: {
        "/": ["staff"],
        "/hooks": ["everyone"],
        "/partner": ["ip:198.51.100.0/24", "ip:203.0.113.9", "token:uptime"],
        "/etl": ["token:etl"],
      },
    });
    const r = await run(f, { account: account() });
    expect(r.errors).toEqual([]);
    expect(appAt(f, `${SITE}/hooks`)!.name).toBe(`infra-sync: web-exception ${SITE}/hooks`);
    expect(policiesOf(f, `${SITE}/hooks`)).toEqual([{ name: "infra-sync: web exception", decision: "bypass", include: [{ everyone: {} }] }]);
    expect(policiesOf(f, `${SITE}/partner`)).toEqual([
      { name: "infra-sync: web exception", decision: "bypass", include: [{ ip: { ip: "198.51.100.0/24" } }, { ip: { ip: "203.0.113.9/32" } }] },
      { name: "infra-sync: web exception service tokens", decision: "non_identity", include: [{ service_token: { token_id: UPTIME_TOKEN } }] },
    ]);
    expect(policiesOf(f, `${SITE}/etl`)).toEqual([
      { name: "infra-sync: web exception service tokens", decision: "non_identity", include: [{ service_token: { token_id: ETL_TOKEN } }] },
    ]);
    // No login on these paths: no WARP sign-in flag.
    expect(appAt(f, `${SITE}/etl`)!.allow_authenticate_via_warp).toBeUndefined();
  });

  it("groups and emails become one Allow policy (groups expanded, deduplicated)", async () => {
    const f = site({ access: { "/": ["devs", "admins", "admin@example.com"] } });
    await run(f, { account: account() });
    expect(policiesOf(f, SITE)).toEqual([
      { name: "infra-sync: web people", decision: "allow", include: ["admin@example.com", DEV, "ops@example.com"].map((email) => ({ email: { email } })) },
    ]);
    expect(appAt(f, SITE)!.allow_authenticate_via_warp).toBe(true);
  });

  it("a mixed list is one app: Bypass by IP, Service Auth, the staff policy, then the people (in that order)", async () => {
    const f = site({ access: { "/": ["everyone"], "/ops": [DEV, "token:etl", "staff", "ip:192.0.2.7"] } });
    await run(f, { account: account() });
    const app = appAt(f, `${SITE}/ops`)!;
    expect(app.name).toBe(`infra-sync: web-admin ${SITE}/ops`); // it needs a login
    expect(app.allow_authenticate_via_warp).toBe(true);
    expect(policiesOf(f, `${SITE}/ops`)).toEqual([
      { name: "infra-sync: web exception", decision: "bypass", include: [{ ip: { ip: "192.0.2.7/32" } }] },
      { name: "infra-sync: web exception service tokens", decision: "non_identity", include: [{ service_token: { token_id: ETL_TOKEN } }] },
      { reusable: STAFF_POLICY },
      { name: "infra-sync: web people", decision: "allow", include: [{ email: { email: DEV } }] },
    ]);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it('a root open only to a token is the whole-site app with Service Auth and no WARP sign-in', async () => {
    const f = site({ access: { "/": ["token:etl"] } });
    await run(f, { account: account() });
    expect(appAt(f, SITE)!.name).toBe(`infra-sync: web ${SITE}`);
    expect(appAt(f, SITE)!.allow_authenticate_via_warp).toBeUndefined();
    expect(policiesOf(f, SITE)).toEqual([
      { name: "infra-sync: web exception service tokens", decision: "non_identity", include: [{ service_token: { token_id: ETL_TOKEN } }] },
    ]);
  });

  it("creates the paths open without a login before the gating apps (the Worker's order); under an open root a token path gates", async () => {
    const staff = site({ access: { "/": ["staff"], "/hooks": ["everyone"], "/admin": ["devs"] } });
    await run(staff, { account: account() });
    const w = staff.writes();
    expect(idx(w, isAppPost(`${SITE}/hooks`))).toBeLessThan(idx(w, isAppPost(SITE)));
    expect(idx(w, isAppPost(SITE))).toBeLessThan(idx(w, isAppPost(`${SITE}/admin`)));

    // Under "/": [everyone] a token-only path keeps everyone else out: it is gating, so a failed
    // create takes the new route down rather than leave the path open.
    const open = site({ access: { "/": ["everyone"], "/api": ["token:etl"] } });
    open.failWhen((c) => (isAppPost(`${SITE}/api`)(c) ? { status: 500 } : undefined));
    const r = await run(open, { account: account() });
    expect(r.result.failed.map((x) => x.op.key)).toContain(`${SITE}/api`);
    expect(rulesOf(open, SITE)).toEqual([]);
  });

  it("the most specific path wins: a path under another gets its own app", async () => {
    const f = site({ access: { "/": ["everyone"], "/admin": ["staff"], "/admin/hooks": ["everyone"] } });
    await run(f, { account: account() });
    expect(policiesOf(f, `${SITE}/admin/hooks`)).toEqual([{ name: "infra-sync: web exception", decision: "bypass", include: [{ everyone: {} }] }]);
    expect(policiesOf(f, `${SITE}/admin`)).toEqual([{ reusable: STAFF_POLICY }]);
  });
});

describe("extra hostnames (decision 19, option a)", () => {
  it('on a site whose "/" is [everyone]: login paths answer 404 in the tunnel; everyone/token/IP paths are apps on every hostname; /healthcheck/ only on the droplet name', async () => {
    const f = site({
      hostnames: [EXTRA],
      access: {
        "/": ["everyone"],
        "/admin": ["staff"],
        "/ops": ["devs", "token:etl"],
        "/hooks": ["everyone"],
        "/api": ["token:uptime"],
        "/partner": ["ip:192.0.2.0/24"],
        "/healthcheck/": ["everyone"],
      },
    });
    const r = await run(f, { account: account() });
    expect(r.errors).toEqual([]);
    // Own name: an app per path, the healthcheck bypass.
    for (const p of ["/admin", "/ops", "/hooks", "/api", "/partner"]) expect(appAt(f, `${SITE}${p}`), p).toBeDefined();
    expect(appAt(f, `${SITE}/healthcheck`)!.name).toBe(`infra-sync: healthcheck ${SITE}`);
    // Extra hostname: no login page anywhere; the login paths (a mixed list too) are 404 rules before the route.
    expect(appAt(f, `${EXTRA}/admin`)).toBeUndefined();
    expect(appAt(f, `${EXTRA}/ops`)).toBeUndefined();
    expect(appAt(f, `${EXTRA}/healthcheck`)).toBeUndefined();
    expect(appAt(f, EXTRA)).toBeUndefined();
    for (const p of ["/hooks", "/api", "/partner"]) expect(appAt(f, `${EXTRA}${p}`), p).toBeDefined();
    expect(rulesOf(f, EXTRA)).toEqual([
      { hostname: EXTRA, path: "^/admin(/.*)?$", service: "http_status:404" },
      { hostname: EXTRA, path: "^/ops(/.*)?$", service: "http_status:404" },
      { hostname: EXTRA, service: `https://${IP}:443`, originRequest: { noTLSVerify: true } },
    ]);
    expect(rulesOf(f, SITE)).toEqual([{ hostname: SITE, service: `https://${IP}:443`, originRequest: { noTLSVerify: true } }]);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it('on a site that needs a login at "/": every hostname gets the same apps, except the public /healthcheck/', async () => {
    const f = site({ hostnames: [EXTRA], access: { "/": ["staff"], "/hooks": ["everyone"], "/healthcheck/": ["everyone"] } });
    await run(f, { account: account() });
    for (const h of [SITE, EXTRA]) {
      expect(policiesOf(f, h)).toEqual([{ reusable: STAFF_POLICY }]);
      expect(appAt(f, `${h}/hooks`)).toBeDefined();
    }
    expect(appAt(f, `${SITE}/healthcheck`)).toBeDefined();
    expect(appAt(f, `${EXTRA}/healthcheck`)).toBeUndefined(); // the login applies there
    expect(rulesOf(f, EXTRA).filter((x) => x.path)).toEqual([]);
  });
});

describe("who-lists in ssh:", () => {
  const appPolicies = (f: FakeCloudflare, host: string) => (f.apps.find((a) => a.domain === host)?.policies ?? []).map((p) => [p.name, p.decision, p.include]);
  const infra = (f: FakeCloudflare) => f.apps.filter((a) => a.type === "infrastructure");

  it("a token is Service Auth on the droplet's ssh- app, never in its infrastructure app", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(1, "a.example.com", "nyc1", "10.0.0.2", ["env-internal"])];
    f.ssh["a.example.com"] = ["admins", "token:etl"];
    await run(f, { account: account() });
    // env internal: the policy keeps the Worker's name for an internal deploy target, whichever token it is.
    expect(appPolicies(f, "ssh-a.example.com")).toEqual([
      ["infra-sync: ci-deploy (internal)", "non_identity", [{ service_token: { token_id: ETL_TOKEN } }]],
      ["infra-sync: ssh-admins", "allow", ADMINS.map((email) => ({ email: { email } }))],
    ]);
    expect(infra(f)).toHaveLength(1);
    expect(JSON.stringify(infra(f)[0]!.policies)).not.toMatch(/service_token/);
  });

  it("a droplet with no env names the token policy without one", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(1, "a.example.com", "nyc1", "10.0.0.2", [])];
    f.ssh["a.example.com"] = ["admins", "token:etl"];
    await run(f, { account: account() });
    expect(appPolicies(f, "ssh-a.example.com")[0]![0]).toBe("infra-sync: ci-deploy");
  });

  it("staff lets in every address in email_domain, on the infrastructure app and the ssh- app; its set differs from the people's", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(1, "a.example.com", "nyc1", "10.0.0.2", ["env-prod"]), droplet(2, "b.example.com", "nyc1", "10.0.0.3", ["env-prod"])];
    f.ssh["a.example.com"] = ["staff"];
    await run(f, { account: account() });
    const tag = (n: string) => f.targets.find((t) => t.hostname === n)!.tags!["ssh-access"];
    expect(tag("a.example.com")).not.toBe(tag("b.example.com"));
    const app = infra(f).find((a) => a.name === `infra-sync: SSH ${tag("a.example.com")}`)!;
    expect(app.policies![0]!.include).toEqual([{ email_domain: { domain: "example.com" } }]);
    expect(app.policies![0]!.connection_rules).toEqual({ ssh: { usernames: ["ubuntu"] } });
    expect(appPolicies(f, "ssh-a.example.com")).toEqual([["infra-sync: ssh-admins", "allow", [{ email_domain: { domain: "example.com" } }]]]);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });
});
