// Decision 21: one WAF custom rule per zone that blocks percent-encoded slashes on the hostnames
// with a path-level login app. Everything here is fake (example.com/.net, placeholder ids).

import { describe, expect, it } from "vitest";
import { WAF_RULE_DESCRIPTION } from "../../src/core/constants.js";
import { hostsOfExpression, WAF_PATH_TEST, wafExpression } from "../../src/cloudflare/waf.js";
import { type Call, changes, droplet, FakeCloudflare, planOnly, run, type RunResult, Z_COM, Z_NET } from "./fake.js";

const SHOP = "shop.example.com";
const BLOG = "blog.example.com";
const TOOLS = "tools.example.com";
const BRAND = "shop.example.net";

/** Droplets with sites; each `web` is written as in a droplet file. */
function sites(webs: Record<string, Record<string, unknown>>): FakeCloudflare {
  const f = new FakeCloudflare();
  let id = 40;
  for (const [name, web] of Object.entries(webs)) {
    id++;
    f.droplets.push(droplet(id, name, "nyc1", `10.0.0.${id}`, ["env-prod"]));
    f.web[name] = web;
  }
  return f;
}

const PUBLIC_ADMIN = { access: { "/": ["everyone"], "/admin": ["staff"] } };
const foreign = (id: string, description: string, expression = 'ip.src eq 198.51.100.7') => ({ id, description, action: "block", expression, enabled: true });
const wafOps = (r: RunResult | { ops: RunResult["plan"]["ops"] }) => ("plan" in r ? r.plan.ops : r.ops).filter((o) => o.kind === "waf-rule");
const wafWrites = (f: FakeCloudflare) => f.writes().filter((c) => c.path.includes("/rulesets"));
const mineIn = (f: FakeCloudflare, zone: string) => (f.waf[zone]?.rules ?? []).filter((r) => r.description === WAF_RULE_DESCRIPTION);

describe("the expression", () => {
  it("lists the hosts lowercased, deduplicated and sorted, and tests the raw path for %2f or %5c in any case", () => {
    expect(wafExpression(["b.example.com", "A.example.com", "b.example.com"])).toBe(
      '(http.host in {"a.example.com" "b.example.com"}) and (lower(raw.http.request.uri.path) contains "%2f" or lower(raw.http.request.uri.path) contains "%5c")',
    );
    expect(WAF_PATH_TEST).not.toMatch(/matches|~/); // no regex: not on the Free plan
  });

  it("reads back only its own form", () => {
    expect(hostsOfExpression(wafExpression(["b.example.com", "a.example.com"]))).toEqual(["a.example.com", "b.example.com"]);
    expect(hostsOfExpression('(http.host in {"b.example.com" "a.example.com"}) and (' + WAF_PATH_TEST + ")")).toBeUndefined(); // not sorted
    expect(hostsOfExpression('(http.host in {"a.example.com"}) and (raw.http.request.uri.path contains "%2F")')).toBeUndefined();
    expect(hostsOfExpression(undefined)).toBeUndefined();
  });
});

describe("which hostnames are in the rule", () => {
  it("a public site's own name, not its extra hostnames (those answer 404 in the tunnel); a login site's extra hostnames too", async () => {
    const f = sites({
      [SHOP]: { ...PUBLIC_ADMIN, hostnames: [BRAND, "shop-brand.example.com"] },
      [TOOLS]: { access: { "/": ["staff"], "/admin": ["admins"] }, hostnames: ["tools2.example.com", "tools.example.net"] },
      [BLOG]: { access: { "/": ["everyone"], "/admin": ["ip:198.51.100.0/24"] } }, // no person: no login app
    });
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(wafOps(r).map((o) => [o.action, o.key, o.after])).toEqual([
      ["create", "example.com", { hosts: [SHOP, TOOLS, "tools2.example.com"] }],
      ["create", "example.net", { hosts: ["tools.example.net"] }],
    ]);
    expect(wafOps(r).every((o) => o.droplet === undefined)).toBe(true);
  });

  it('"/" alone, or paths open without a login, need no rule', async () => {
    const f = sites({ [SHOP]: { access: { "/": ["staff"], "/hooks": ["everyone"] } }, [BLOG]: { access: { "/": ["everyone"], "/healthcheck/": ["everyone"], "/admin": ["staff"] } } });
    const r = await run(f, { apply: false });
    expect(wafOps(r).map((o) => o.after)).toEqual([{ hosts: [BLOG] }]);
  });

  it("leaves out a frozen droplet's hostnames (frozen: no change)", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN, [BLOG]: PUBLIC_ADMIN });
    f.frozen.add(BLOG);
    const r = await run(f);
    expect(wafOps(r).map((o) => [o.action, o.after])).toEqual([["create", { hosts: [SHOP] }]]);
    expect(f.waf[Z_COM]!.rules![0]!.expression).not.toContain(BLOG);

    // Only the frozen droplet has a login path: no rule in its zone.
    const g = sites({ [BLOG]: PUBLIC_ADMIN });
    g.frozen.add(BLOG);
    expect(wafOps(await run(g))).toEqual([]);
    expect(g.waf[Z_COM]).toBeUndefined();
  });
});

describe("planning and applying the rule", () => {
  it("ruleset missing: creates the zone's entry point ruleset with only this rule", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    const r = await run(f);
    expect(r.result.failed).toEqual([]);
    expect(wafOps(r)[0]).toMatchObject({ action: "create", key: "example.com", before: null, after: { hosts: [SHOP] } });
    expect(wafWrites(f).map((c) => [c.method, c.path.replace(/^\/client\/v4/, "")])).toEqual([["POST", `/zones/${Z_COM}/rulesets`]]);
    expect(wafWrites(f)[0]!.body).toEqual({
      name: "default",
      kind: "zone",
      phase: "http_request_firewall_custom",
      rules: [{ description: WAF_RULE_DESCRIPTION, action: "block", expression: wafExpression([SHOP]), enabled: true }],
    });
    // After the site's own objects.
    const all = f.writes();
    expect(all.findIndex((c) => c.path.includes("/rulesets"))).toBe(all.length - 1);
  });

  it("noop when the rule matches", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    await run(f);
    const p = await planOnly(f);
    expect(changes(p)).toEqual([]);
    expect(wafOps(p)).toEqual([]);
  });

  it("update when the host set changes: only this rule is patched, in place", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = { id: "rs-1", rules: [foreign("r-a", "partner allow"), foreign("r-b", "block a bot")] };
    await run(f);
    const rules = () => f.waf[Z_COM]!.rules!.map((r) => r.id);
    const mine = mineIn(f, Z_COM)[0]!.id;
    expect(rules()).toEqual([mine, "r-a", "r-b"]); // added first, so no earlier skip rule can bypass it

    f.droplets.push(droplet(50, BLOG, "nyc1", "10.0.0.50", ["env-prod"]));
    f.web[BLOG] = PUBLIC_ADMIN;
    const before = f.calls.length;
    const r = await run(f);
    expect(wafOps(r)).toEqual([expect.objectContaining({ action: "update", key: "example.com", before: { hosts: [SHOP] }, after: { hosts: [BLOG, SHOP] } })]);
    const w = f.calls.slice(before).filter((c) => c.method !== "GET" && c.path.includes("/rulesets"));
    expect(w.map((c) => [c.method, c.path.replace(/^\/client\/v4/, "")])).toEqual([["PATCH", `/zones/${Z_COM}/rulesets/rs-1/rules/${mine}`]]);
    expect(rules()).toEqual([mine, "r-a", "r-b"]);
    expect(mineIn(f, Z_COM)[0]!.expression).toBe(wafExpression([SHOP, BLOG]));
  });

  it("an existing but empty ruleset (the tool deleted its last rule) gets the rule added, not a second ruleset", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = { id: "rs-1", rules: [] };
    const r = await run(f);
    expect(r.result.failed).toEqual([]);
    const w = wafWrites(f);
    expect(w.map((c) => [c.method, c.path.replace(/^\/client\/v4/, "")])).toEqual([["POST", `/zones/${Z_COM}/rulesets/rs-1/rules`]]);
    expect(w[0]!.body.position).toEqual({ before: "" });
    expect(f.waf[Z_COM]!.rules!.map((x) => x.description)).toEqual([WAF_RULE_DESCRIPTION]);
  });

  it("delete when no hosts remain (the zone's other rules stay)", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = { id: "rs-1", rules: [foreign("r-a", "partner allow")] };
    await run(f);
    f.web[SHOP] = { access: { "/": ["staff"] } };
    const r = await run(f);
    expect(wafOps(r)).toEqual([expect.objectContaining({ action: "delete", key: "example.com", before: { hosts: [SHOP] }, after: null })]);
    expect(f.waf[Z_COM]!.rules!.map((r) => r.id)).toEqual(["r-a"]);
  });

  it("foreign rules are never touched, even one whose description starts with the marker", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    const others = [
      foreign("r-a", "infra-sync: something else", wafExpression(["old.example.com"])),
      foreign("r-b", `${WAF_RULE_DESCRIPTION} (copy)`),
      { ...foreign("r-c", "rate limit login"), action: "managed_challenge" },
    ];
    f.waf[Z_COM] = { id: "rs-1", rules: structuredClone(others) };
    f.waf[Z_NET] = { id: "rs-2", rules: [foreign("r-d", "net rule")] };
    const r = await run(f);
    expect(wafOps(r).map((o) => `${o.action} ${o.key}`)).toEqual(["create example.com"]);
    const touched = wafWrites(f).map((c) => c.path);
    expect(touched.every((p) => !/\/rules\/r-/.test(p) && !p.includes(Z_NET))).toBe(true);
    expect(f.waf[Z_COM]!.rules!.slice(1)).toEqual(others);
    expect(f.waf[Z_NET]!.rules).toEqual([foreign("r-d", "net rule")]);
  });

  it("a disabled or hand-edited rule of the tool is put back; a duplicate goes", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = {
      id: "rs-1",
      rules: [
        { id: "m-1", description: WAF_RULE_DESCRIPTION, action: "log", expression: 'http.host eq "shop.example.com"', enabled: false },
        { id: "m-2", description: WAF_RULE_DESCRIPTION, action: "block", expression: wafExpression([SHOP]), enabled: true },
      ],
    };
    const r = await run(f);
    expect(wafOps(r).map((o) => [o.action, o.key, o.before, o.after])).toEqual([
      ["update", "example.com", { expression: 'http.host eq "shop.example.com"', action: "log", enabled: false }, { hosts: [SHOP] }],
      ["delete", "example.com (duplicate m-2)", { hosts: [SHOP] }, null],
    ]);
    expect(wafOps(r)[0]!.reason).toMatch(/changed outside the tool/);
    expect(f.waf[Z_COM]!.rules).toEqual([{ id: "m-1", ...{ description: WAF_RULE_DESCRIPTION, action: "block", expression: wafExpression([SHOP]), enabled: true } }]);
    expect(changes(await planOnly(f))).toEqual([]);
  });

  it("limit reached: a conflict for the zone, a report op, nothing created", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = { id: "rs-1", rules: [1, 2, 3, 4, 5].map((i) => foreign(`r-${i}`, `rule ${i}`)) };
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => /WAF custom rules, the limit of its plan \(5\)/.test(w))).toHaveLength(1);
    expect(r.plan.diagnostics.find((d) => /limit of its plan/.test(d.message))?.code).toBe("cloudflare-conflict");
    expect(wafOps(r).map((o) => [o.action, o.key])).toEqual([["report", "example.com"]]);
    expect(wafWrites(f)).toEqual([]);

    // The zone's plan sets the limit: a Pro zone (20) has room for it.
    f.zones = f.zones.map((z) => (z.id === Z_COM ? { ...z, plan: { legacy_id: "pro" } } : z));
    const r2 = await run(f);
    expect(wafOps(r2).map((o) => [o.action, o.key])).toEqual([["create", "example.com"]]);
    expect(f.waf[Z_COM]!.rules).toHaveLength(6);
  });

  it("an expression over Cloudflare's 4,096 characters is a conflict, not a failed write", async () => {
    const hosts = Array.from({ length: 120 }, (_, i) => `brand-${i}-with-a-long-name.example.com`);
    const f = sites({ [TOOLS]: { access: { "/": ["staff"], "/admin": ["admins"] }, hostnames: hosts } });
    const r = await run(f);
    expect(wafOps(r).map((o) => o.action)).toEqual(["report"]);
    expect(r.warnings.some((w) => /over Cloudflare's 4096/.test(w))).toBe(true);
    expect(wafWrites(f)).toEqual([]);
  });

  it("deletes held back by the guard rails become report ops", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.waf[Z_COM] = { id: "rs-1", rules: [{ id: "m-1", description: WAF_RULE_DESCRIPTION, action: "block", expression: wafExpression([SHOP]), enabled: true }] };
    f.web[SHOP] = { access: { "/": ["staff"] } };
    // A tunnel that can't be read blocks every delete.
    f.failWhen((c: Call) => (c.method === "GET" && c.path.includes("/cfd_tunnel/") ? { status: 500 } : undefined));
    const r = await run(f);
    expect(wafOps(r)).toEqual([expect.objectContaining({ action: "report", key: "example.com" })]);
    expect(wafOps(r)[0]!.reason).toMatch(/not deleted this run/);
    expect(mineIn(f, Z_COM)).toHaveLength(1);
  });
});

describe("a WAF read that fails", () => {
  it("is an error naming the token permission; the rest of the Cloudflare plan is still made", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.failWhen((c) =>
      c.method === "GET" && c.path.endsWith("/rulesets/phases/http_request_firewall_custom/entrypoint")
        ? { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } }
        : undefined,
    );
    const r = await run(f, { apply: false });
    // One error for the one failure, naming the permission first and every zone it hit.
    const errs = r.plan.diagnostics.filter((d) => d.level === "error");
    expect(errs.map((d) => d.code)).toEqual(["cloudflare-waf-read-error"]);
    expect(errs[0]!.message).toMatch(/^The WAF custom rules could not be read: the Cloudflare token needs the zone permission "Zone WAF: Edit" \(API name "Zone WAF Write"\)/);
    expect(errs[0]!.message).toContain("3 zone(s): example.com, example.net, example.org. Error: cloudflare GET /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint: HTTP 403");
    expect(wafOps(r)).toEqual([]);
    // Not a read failure of the rest: the site is planned as usual and deletions stay allowed.
    expect(changes(r.plan).some((o) => o.kind === "access-app" && o.key === `${SHOP}/admin`)).toBe(true);
    expect(r.plan.diagnostics.some((d) => d.code === "cloudflare-guard")).toBe(false);
  });

  it("only a 404 means the zone has no ruleset yet", async () => {
    const f = sites({ [SHOP]: PUBLIC_ADMIN });
    f.failWhen((c) => (c.method === "GET" && c.path.endsWith(`/zones/${Z_NET}/rulesets/phases/http_request_firewall_custom/entrypoint`) ? { status: 500 } : undefined));
    const r = await run(f, { apply: false });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/1 zone\(s\): example\.net\. Error: cloudflare GET .*HTTP 500/);
    expect(wafOps(r).map((o) => `${o.action} ${o.key}`)).toEqual(["create example.com"]);
  });
});
