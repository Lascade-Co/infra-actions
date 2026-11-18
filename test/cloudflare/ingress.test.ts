// Ported from the infra-sync Worker's test/ingress.test.ts, with fake names and addresses.

import { describe, expect, it } from "vitest";
import { mergeIngress, protectedPathRegex, routeLive, rulesFor, sameGroup, toGroup, type UpsertTarget } from "../../src/cloudflare/ingress.js";
import type { IngressRule, TunnelConfigDoc } from "../../src/cloudflare/types.js";

const manualDashboard = {
  hostname: "manual-dashboard.example.com",
  service: "https://10.0.1.13:443",
  originRequest: { originServerName: "dashboard.internal.example.com", noTLSVerify: false },
};
const spikeSsh = { hostname: "ssh-spike.example.com", service: "ssh://localhost:22" };
const spikePg = { hostname: "pg-spike.example.com", service: "tcp://localhost:55432" };

function base(): TunnelConfigDoc {
  return {
    ingress: [manualDashboard, spikeSsh, spikePg, { service: "http_status:404" }],
    originRequest: { connectTimeout: 30 },
    "warp-routing": { enabled: true },
    someFutureKey: { x: 1 },
  };
}

describe("mergeIngress", () => {
  it("adds an owned rule and preserves every manual rule, top-level keys and the catch-all", () => {
    const r = mergeIngress(base(), {
      upserts: new Map([["ssh-staging-esim.example.com", "ssh://10.0.1.5:22"]]),
      removes: new Set(),
      owned: new Set(),
    });
    expect(r.changed).toBe(true);
    expect(r.added).toEqual(["ssh-staging-esim.example.com"]);
    expect(r.config.ingress).toEqual([
      manualDashboard,
      spikeSsh,
      spikePg,
      { hostname: "ssh-staging-esim.example.com", service: "ssh://10.0.1.5:22" },
      { service: "http_status:404" },
    ]);
    expect(r.config.originRequest).toEqual({ connectTimeout: 30 });
    expect(r.config["warp-routing"]).toEqual({ enabled: true });
    expect(r.config.someFutureKey).toEqual({ x: 1 });
  });

  it("never removes or rewrites an ssh-* rule it cannot prove it owns (ssh-spike)", () => {
    const r = mergeIngress(base(), {
      upserts: new Map(),
      removes: new Set(["ssh-spike.example.com", "manual-dashboard.example.com"]),
      owned: new Set(), // no Access app of the tool for ssh-spike
    });
    expect(r.changed).toBe(false);
    expect(r.config.ingress).toEqual(base().ingress);
  });

  it("reports an upsert that collides with a foreign rule and leaves the foreign rule alone", () => {
    const r = mergeIngress(base(), {
      upserts: new Map([["ssh-spike.example.com", "ssh://10.0.1.7:22"]]),
      removes: new Set(),
      owned: new Set(),
    });
    expect(r.conflicts).toEqual(["ssh-spike.example.com"]);
    expect(r.changed).toBe(false);
    expect(r.config.ingress).toEqual(base().ingress);
  });

  it("updates and removes only owned rules", () => {
    const cfg = base();
    cfg.ingress!.splice(3, 0, { hostname: "ssh-click.example.com", service: "ssh://10.0.0.3:22" }, { hostname: "ssh-gone.example.com", service: "ssh://10.0.0.4:22" });
    const r = mergeIngress(cfg, {
      upserts: new Map([["ssh-click.example.com", "ssh://10.0.0.99:22"]]),
      removes: new Set(["ssh-gone.example.com"]),
      owned: new Set(["ssh-click.example.com", "ssh-gone.example.com"]),
    });
    expect(r.updated).toEqual(["ssh-click.example.com"]);
    expect(r.removed).toEqual(["ssh-gone.example.com"]);
    expect(r.config.ingress).toEqual([manualDashboard, spikeSsh, spikePg, { hostname: "ssh-click.example.com", service: "ssh://10.0.0.99:22" }, { service: "http_status:404" }]);
  });

  it("adds a catch-all when the tunnel had none, and keeps it last", () => {
    const r = mergeIngress({ ingress: [manualDashboard] }, { upserts: new Map([["ssh-a.example.com", "ssh://10.0.0.1:22"]]), removes: new Set(), owned: new Set() });
    expect(r.config.ingress?.at(-1)).toEqual({ service: "http_status:404" });
    expect(r.config.ingress?.[0]).toEqual(manualDashboard);
  });

  it("inserts new owned rules before a wildcard rule that would shadow them", () => {
    const r = mergeIngress(
      { ingress: [manualDashboard, { hostname: "*.example.com", service: "http://10.0.0.2:80" }, { service: "http_status:404" }] },
      { upserts: new Map([["ssh-a.example.com", "ssh://10.0.0.1:22"]]), removes: new Set(), owned: new Set() },
    );
    expect(r.config.ingress?.map((x) => x.hostname)).toEqual(["manual-dashboard.example.com", "ssh-a.example.com", "*.example.com", undefined]);
  });

  it("is a no-op when the owned rule is already correct", () => {
    const cfg = base();
    cfg.ingress!.splice(3, 0, { hostname: "ssh-click.example.com", service: "ssh://10.0.0.3:22" });
    const r = mergeIngress(cfg, { upserts: new Map([["ssh-click.example.com", "ssh://10.0.0.3:22"]]), removes: new Set(), owned: new Set(["ssh-click.example.com"]) });
    expect(r.changed).toBe(false);
  });

  it("does not mutate its input", () => {
    const cfg = base();
    const snapshot = JSON.stringify(cfg);
    mergeIngress(cfg, { upserts: new Map([["ssh-x.example.com", "ssh://10.0.0.1:22"]]), removes: new Set(), owned: new Set() });
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });

  it("owns site rules only through ownedWeb, writes their originRequest, and leaves a correct one alone", () => {
    const site = { service: "https://10.0.1.40:443", originRequest: { noTLSVerify: true } };
    const add = mergeIngress(base(), { upserts: new Map([["staging-pilot.example.com", site]]), removes: new Set(), owned: new Set() });
    expect(add.added).toEqual(["staging-pilot.example.com"]);
    expect(add.config.ingress?.[3]).toEqual({ hostname: "staging-pilot.example.com", ...site });

    // A correct owned rule with originRequest is not rewritten (no write every run).
    const same = mergeIngress(add.config, {
      upserts: new Map([["staging-pilot.example.com", { service: site.service, originRequest: { noTLSVerify: true } }]]),
      removes: new Set(),
      owned: new Set(),
      ownedWeb: new Set(["staging-pilot.example.com"]),
    });
    expect(same.changed).toBe(false);

    // Switching to an http origin drops originRequest.
    const http = mergeIngress(add.config, {
      upserts: new Map([["staging-pilot.example.com", "http://10.0.1.40:80"]]),
      removes: new Set(),
      owned: new Set(),
      ownedWeb: new Set(["staging-pilot.example.com"]),
    });
    expect(http.updated).toEqual(["staging-pilot.example.com"]);
    expect(http.config.ingress?.[3]).toEqual({ hostname: "staging-pilot.example.com", service: "http://10.0.1.40:80" });
  });

  it("never takes over a manual site rule, even when asked to upsert or remove it", () => {
    const r = mergeIngress(base(), {
      upserts: new Map([["manual-dashboard.example.com", { service: "https://10.0.1.13:443", originRequest: { noTLSVerify: true } }]]),
      removes: new Set(["manual-dashboard.example.com"]),
      owned: new Set(["manual-dashboard.example.com"]), // the ssh- set never makes a non-ssh rule owned
    });
    expect(r.conflicts).toEqual(["manual-dashboard.example.com"]);
    expect(r.changed).toBe(false);
    expect(r.config.ingress?.[0]).toEqual(manualDashboard);
  });

  it("an ssh-* rule is never owned through ownedWeb", () => {
    const r = mergeIngress(base(), { upserts: new Map(), removes: new Set(["ssh-spike.example.com"]), owned: new Set(), ownedWeb: new Set(["ssh-spike.example.com"]) });
    expect(r.changed).toBe(false);
  });
});

describe("protectedPathRegex", () => {
  it("matches the path and everything under it, not unrelated prefixes", () => {
    expect(protectedPathRegex("/admin")).toBe("^/admin(/.*)?$");
    expect(protectedPathRegex("/admin/")).toBe("^/admin(/.*)?$");
    const re = new RegExp(protectedPathRegex("/admin"));
    for (const p of ["/admin", "/admin/", "/admin/users/1"]) expect(re.test(p)).toBe(true);
    for (const p of ["/administrator", "/admin.php", "/x/admin", "/"]) expect(re.test(p)).toBe(false);
  });

  it("escapes regex metacharacters in a configured path", () => {
    expect(protectedPathRegex("/v1.0/(beta)+$x*/")).toBe("^/v1\\.0/\\(beta\\)\\+\\$x\\*(/.*)?$");
    const re = new RegExp(protectedPathRegex("/v1.0/(beta)+"));
    expect(re.test("/v1.0/(beta)+")).toBe(true);
    expect(re.test("/v1.0/(beta)+/x")).toBe(true);
    expect(re.test("/v1x0/(beta)+")).toBe(false);
    expect(re.test("/v1.0/beta")).toBe(false);
  });
});

describe("mergeIngress: rule groups (404 path rules + main rule)", () => {
  const BRAND = "shop.example.net";
  const site = { service: "http://10.0.0.7:80", notFoundPaths: ["^/admin(/.*)?$", "^/staff(/.*)?$"] };
  const group = [
    { hostname: BRAND, path: "^/admin(/.*)?$", service: "http_status:404" },
    { hostname: BRAND, path: "^/staff(/.*)?$", service: "http_status:404" },
    { hostname: BRAND, service: "http://10.0.0.7:80" },
  ];
  const ownedWeb = new Set([BRAND]);
  const ssh = { hostname: "ssh-click.example.com", service: "ssh://10.0.0.3:22" };

  it("adds a new group before any wildcard rule, path rules first, reported once", () => {
    const r = mergeIngress(
      { ingress: [manualDashboard, { hostname: "*.example.com", service: "http://10.0.0.2:80" }, { service: "http_status:404" }] },
      { upserts: new Map([[BRAND, site]]), removes: new Set(), owned: new Set() },
    );
    expect(r.added).toEqual([BRAND]);
    expect(r.config.ingress).toEqual([manualDashboard, ...group, { hostname: "*.example.com", service: "http://10.0.0.2:80" }, { service: "http_status:404" }]);
  });

  it("rewrites an old single rule into the group in place, keeping its position among foreign and ssh- rules", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, { hostname: BRAND, service: "http://10.0.0.7:80" }, ssh);
    const upserts = new Map<string, UpsertTarget>([
      [BRAND, site],
      [ssh.hostname, ssh.service],
    ]);
    const r = mergeIngress(cfg, { upserts, removes: new Set(), owned: new Set([ssh.hostname]), ownedWeb });
    expect(r.updated).toEqual([BRAND]);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(r.config.ingress).toEqual([manualDashboard, ...group, ssh, spikeSsh, spikePg, { service: "http_status:404" }]);
    expect(r.config["warp-routing"]).toEqual({ enabled: true });

    // Idempotent: the same change against the result writes nothing.
    const again = mergeIngress(r.config, { upserts, removes: new Set(), owned: new Set([ssh.hostname]), ownedWeb });
    expect(again.changed).toBe(false);
    expect(again.updated).toEqual([]);
  });

  it("rewrites a group whose paths changed, and drops a non-contiguous copy (one update)", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, group[0]!, { hostname: BRAND, service: "http://10.0.0.7:80" }); // old group: /admin only
    cfg.ingress!.splice(4, 0, { hostname: BRAND, service: "http://10.0.0.99:80" }); // stray copy between spikeSsh and spikePg
    const r = mergeIngress(cfg, { upserts: new Map([[BRAND, site]]), removes: new Set(), owned: new Set(), ownedWeb });
    expect(r.updated).toEqual([BRAND]);
    expect(r.removed).toEqual([]);
    expect(r.config.ingress).toEqual([manualDashboard, ...group, spikeSsh, spikePg, { service: "http_status:404" }]);
  });

  it("back to a single rule (e.g. switched to staff): the 404 rules go, in place", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, ...group);
    const r = mergeIngress(cfg, { upserts: new Map([[BRAND, "http://10.0.0.7:80"]]), removes: new Set(), owned: new Set(), ownedWeb });
    expect(r.updated).toEqual([BRAND]);
    expect(r.config.ingress).toEqual([manualDashboard, { hostname: BRAND, service: "http://10.0.0.7:80" }, spikeSsh, spikePg, { service: "http_status:404" }]);
  });

  it("removing the hostname removes the whole group, reported once", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, ...group);
    const r = mergeIngress(cfg, { upserts: new Map(), removes: new Set([BRAND]), owned: new Set(), ownedWeb });
    expect(r.removed).toEqual([BRAND]);
    expect(r.config.ingress).toEqual(base().ingress);
  });

  it("an owned group that is not upserted this run is kept as it is, 404 rules included", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, ...group);
    const r = mergeIngress(cfg, { upserts: new Map([["ssh-a.example.com", "ssh://10.0.0.1:22"]]), removes: new Set(), owned: new Set(), ownedWeb });
    expect(r.updated).toEqual([]);
    expect(r.config.ingress).toEqual([manualDashboard, ...group, spikeSsh, spikePg, { hostname: "ssh-a.example.com", service: "ssh://10.0.0.1:22" }, { service: "http_status:404" }]);
  });

  it("a group for a hostname it does not own is a conflict and nothing is written", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, { hostname: BRAND, service: "http://10.9.9.9:80" });
    const r = mergeIngress(cfg, { upserts: new Map([[BRAND, site]]), removes: new Set(), owned: new Set() });
    expect(r.conflicts).toEqual([BRAND]);
    expect(r.changed).toBe(false);
  });
});

describe("explicit rule groups (what apply replays from a planned op)", () => {
  const H = "shop.example.net";
  const planned: IngressRule[] = [
    { hostname: H, path: "^/admin(/.*)?$", service: "http_status:404" },
    { hostname: H, service: "http://10.0.0.7:80" },
  ];

  it("toGroup returns a copy of an explicit group, and builds the same rules as the target it came from", () => {
    const g = toGroup(H, { rules: planned });
    expect(g).toEqual(planned);
    expect(g).not.toBe(planned);
    g[0]!.service = "changed";
    expect(planned[0]!.service).toBe("http_status:404");
    expect(toGroup(H, { service: "http://10.0.0.7:80", notFoundPaths: ["^/admin(/.*)?$"] })).toEqual(planned);
  });

  it("upserting an explicit group adds it, and is a no-op once it is there", () => {
    const add = mergeIngress(base(), { upserts: new Map([[H, { rules: planned }]]), removes: new Set(), owned: new Set() });
    expect(add.added).toEqual([H]);
    expect(add.config.ingress).toEqual([manualDashboard, spikeSsh, spikePg, ...planned, { service: "http_status:404" }]);
    const again = mergeIngress(add.config, { upserts: new Map([[H, { rules: planned }]]), removes: new Set(), owned: new Set(), ownedWeb: new Set([H]) });
    expect(again.changed).toBe(false);
    expect(routeLive(add.config, H, { rules: planned })).toBe(true);
    expect(routeLive(base(), H, { rules: planned })).toBe(false);
  });

  it("rulesFor returns a hostname's rules in order, case-insensitively; sameGroup compares them field-wise", () => {
    const cfg = base();
    cfg.ingress!.splice(1, 0, { hostname: "Shop.Example.NET", path: "^/admin(/.*)?$", service: "http_status:404" }, { hostname: H, service: "http://10.0.0.7:80", extraApiKey: 1 });
    const rules = rulesFor(cfg, H);
    expect(rules).toHaveLength(2);
    // Keys the API may add to a rule don't count, nor does the hostname's case.
    expect(sameGroup(rules, planned)).toBe(true);
    expect(sameGroup(rules, planned.slice(1))).toBe(false);
    expect(sameGroup(rules, [planned[0]!, { hostname: H, service: "http://10.0.0.8:80" }])).toBe(false);
    expect(sameGroup([{ hostname: H, service: "https://10.0.0.7:443", originRequest: { noTLSVerify: true } }], [{ hostname: H, service: "https://10.0.0.7:443" }])).toBe(false);
    expect(rulesFor(undefined, H)).toEqual([]);
  });
});
