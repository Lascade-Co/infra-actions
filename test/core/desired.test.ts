import { describe, expect, it } from "vitest";
import { accessFor, buildDesired, desiredWeb, pathUnder, resolvePeople, tokenNames, type DesiredWeb } from "../../src/core/desired.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import { parseWhoList } from "../../src/core/values.js";
import { exampleFiles, exampleWith, observedDroplet } from "../helpers.js";

async function example() {
  return loadInfraFiles(await exampleFiles()).config!;
}

const existing = [
  observedDroplet("shop.example.com", { id: 1, privateIpv4: "10.0.0.11", tags: ["env-prod", "ci-deploy", "web-public", "production"] }),
  observedDroplet("db.example.com", { id: 2, privateIpv4: "10.0.0.12" }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13" }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14" }),
  observedDroplet("build-box", { id: 5, region: "blr1" }),
];

describe("buildDesired", () => {
  it("joins files with droplets: exists, create, unmanaged", async () => {
    const d = buildDesired(await example(), existing);
    const status = Object.fromEntries(d.droplets.map((x) => [x.name, x.status]));
    expect(status).toEqual({
      "db.example.com": "exists",
      "shop.example.com": "exists",
      "staging-shop.example.com": "create",
      "tools.example.net": "exists",
      "worker-2.example.com": "create",
      "worker.example.com": "exists",
    });
    expect(d.unmanaged.map((x) => x.name)).toEqual(["build-box"]);
    expect(d.diagnostics).toEqual([]);
  });

  it("places a new droplet in its env's region with that region's tunnel, IPs unknown", async () => {
    const d = buildDesired(await example(), existing);
    const s = d.droplets.find((x) => x.name === "staging-shop.example.com")!;
    expect(s).toMatchObject({ region: "blr1", tunnelId: "00000000-0000-4000-8000-000000000002" });
    expect(s.privateIpv4).toBeUndefined();
    expect(s.profile?.name).toBe("ubuntu-6");
  });

  it("adds generated names, IPs and the observed region for existing droplets", async () => {
    const d = buildDesired(await example(), existing);
    const shop = d.droplets.find((x) => x.name === "shop.example.com")!;
    expect(shop).toMatchObject({
      zone: "example.com",
      label: "shop",
      sshHostname: "ssh-shop.example.com",
      vpcHostname: "vpc-shop.example.com",
      region: "nyc1",
      tunnelId: "00000000-0000-4000-8000-000000000001",
      privateIpv4: "10.0.0.11",
      observed: { id: 1 },
    });
    expect(shop.profile).toBeUndefined();
  });

  it("tags a droplet only with its env's old firewall tag (decision 20)", async () => {
    const files = await exampleWith({ "droplets/x.example.com.yaml": "name: x.example.com\nssh: [admins]\n" });
    const d = buildDesired(loadInfraFiles(files).config!, existing);
    const tags = Object.fromEntries(d.droplets.map((x) => [x.name, x.tags]));
    expect(tags).toEqual({
      "db.example.com": ["production"],
      "shop.example.com": ["production"],
      "staging-shop.example.com": ["staging"],
      "tools.example.net": ["internal"],
      "worker-2.example.com": ["production"],
      "worker.example.com": ["production"],
      "x.example.com": [],
    });
  });

  it("splits the ssh list into people, staff and service tokens", async () => {
    const files = await exampleWith({ "droplets/x.example.com.yaml": "name: x.example.com\nssh: [token:etl, staff, Someone@example.com, token:ci-prod, shop-team]\n" });
    const d = buildDesired(loadInfraFiles(files).config!, existing);
    const x = d.droplets.find((y) => y.name === "x.example.com")!;
    expect(x).toMatchObject({ sshEmails: ["dev@example.com", "someone@example.com"], sshStaff: true, sshTokens: ["ci-prod", "etl"] });
    const shop = d.droplets.find((y) => y.name === "shop.example.com")!;
    expect(shop).toMatchObject({ sshEmails: ["admin@example.com", "dev@example.com", "ops@example.com"], sshStaff: false, sshTokens: ["ci-prod"] });
    expect(x).not.toHaveProperty("deploy");
  });

  it("applies web defaults", async () => {
    const files = await exampleWith({
      "droplets/a.example.com.yaml": "name: a.example.com\nssh: [admins]\nweb:\n  access:\n    /: [everyone]\n",
      "droplets/b.example.com.yaml": "name: b.example.com\nssh: [admins]\nenv: prod\nweb:\n  hostnames: [b.example.net]\n  access:\n    /: [staff]\n    /healthcheck/: [everyone]\n",
      "droplets/c.example.com.yaml": "name: c.example.com\nssh: [admins]\nweb:\n  access:\n    /: [everyone]\n    /healthcheck: [staff]\n",
    });
    const d = buildDesired(loadInfraFiles(files).config!, [observedDroplet("a.example.com"), observedDroplet("b.example.com"), observedDroplet("c.example.com")]);
    const a = d.droplets.find((x) => x.name === "a.example.com")!;
    expect(a.web).toMatchObject({
      origin: "https://{ip}:443",
      rootOpen: true,
      publicHealthcheck: false,
      healthPath: "/",
      healthAcceptApp404: false,
      hostnames: ["a.example.com"],
      extraHostnames: [],
    });
    const b = d.droplets.find((x) => x.name === "b.example.com")!;
    expect(b.web).toMatchObject({ rootOpen: false, publicHealthcheck: true, healthPath: "/healthcheck/", hostnames: ["b.example.com", "b.example.net"], extraHostnames: ["b.example.net"] });
    // /healthcheck behind a login is not the public healthcheck: the health path stays "/".
    const c = d.droplets.find((x) => x.name === "c.example.com")!;
    expect(c.web).toMatchObject({ publicHealthcheck: false, healthPath: "/" });
    expect(b.monitors).toEqual([
      { type: "http", hostname: "b.example.com", path: "/healthcheck/", acceptApp404: false },
      { type: "http", hostname: "b.example.net", path: "/healthcheck/", acceptApp404: false },
    ]);
  });

  it("keeps an explicit health_path over the /healthcheck/ default", async () => {
    const d = buildDesired(await example(), existing);
    expect(d.droplets.find((x) => x.name === "tools.example.net")!.web).toMatchObject({ healthPath: "/status", publicHealthcheck: false, healthAcceptApp404: true });
    expect(d.droplets.find((x) => x.name === "staging-shop.example.com")!.web).toMatchObject({ healthPath: "/healthcheck/", publicHealthcheck: true });
  });

  it("parses web.access: who-lists, normalised paths, everyone and needsLogin", async () => {
    const d = buildDesired(await example(), existing);
    const shop = d.droplets.find((x) => x.name === "shop.example.com")!.web!;
    expect(shop.rootOpen).toBe(true);
    expect(shop.access).toEqual([
      { path: "/", norm: "", who: [{ kind: "everyone" }], everyone: true, needsLogin: false },
      { path: "/admin", norm: "/admin", who: [{ kind: "staff" }], everyone: false, needsLogin: true },
      { path: "/internal", norm: "/internal", who: [{ kind: "staff" }], everyone: false, needsLogin: true },
      { path: "/webhooks/payments", norm: "/webhooks/payments", who: [{ kind: "everyone" }], everyone: true, needsLogin: false },
      {
        path: "/api/partner",
        norm: "/api/partner",
        who: [
          { kind: "ip", cidr: "198.51.100.0/24" },
          { kind: "ip", cidr: "203.0.113.9/32" },
          { kind: "token", name: "uptime" },
        ],
        everyone: false,
        needsLogin: false,
      },
      { path: "/healthcheck/", norm: "/healthcheck", who: [{ kind: "everyone" }], everyone: true, needsLogin: false },
    ]);
    const tools = d.droplets.find((x) => x.name === "tools.example.net")!.web!;
    expect(tools.rootOpen).toBe(false);
    expect(tools.access.find((a) => a.path === "/reports")).toEqual({
      path: "/reports",
      norm: "/reports",
      who: [
        { kind: "group", name: "shop-team" },
        { kind: "email", email: "tools-owner@example.com" },
      ],
      everyone: false,
      needsLogin: true,
    });
  });

  it("fills explicit monitors from web and keeps [] as none", async () => {
    const d = buildDesired(await example(), existing);
    expect(d.droplets.find((x) => x.name === "tools.example.net")!.monitors).toEqual([
      { type: "http", hostname: "tools.example.net", path: "/api/health", acceptApp404: true },
    ]);
    expect(d.droplets.find((x) => x.name === "db.example.com")!.monitors).toEqual([]);
    expect(d.droplets.find((x) => x.name === "worker.example.com")!.monitors).toEqual([]);
  });

  it("reports a file with no droplet and no profile, and duplicate droplet names", async () => {
    const d = buildDesired(await example(), [...existing.filter((x) => x.name !== "db.example.com"), observedDroplet("shop.example.com", { id: 99 })]);
    expect(d.droplets.find((x) => x.name === "db.example.com")!.status).toBe("missing");
    expect(d.droplets.find((x) => x.name === "shop.example.com")!.status).toBe("conflict");
    expect(d.droplets.find((x) => x.name === "shop.example.com")!.observed).toBeUndefined();
    expect(d.diagnostics.map((x) => [x.code, x.droplet])).toEqual([
      ["droplet-not-found", "db.example.com"],
      ["duplicate-droplet", "shop.example.com"],
    ]);
  });

  it("keeps naming problems as namingError for the checks to report", async () => {
    const files = await exampleWith({ "droplets/x.example.org.yaml": "name: x.example.org\nssh: [admins]\n" });
    const d = buildDesired(loadInfraFiles(files).config!, [observedDroplet("x.example.org")]);
    const x = d.droplets.find((y) => y.name === "x.example.org")!;
    expect(x.sshHostname).toBeUndefined();
    expect(x.namingError).toContain("not a domain in any account zone");
  });
});

describe("who-list helpers", () => {
  it("resolvePeople expands groups, lowercases, deduplicates and sorts; unknown groups add no one", async () => {
    const { account } = await example();
    expect(resolvePeople(account, parseWhoList(["shop-team", "Ops@example.com", "admins", "staff", "token:etl", "ghosts"]))).toEqual([
      "admin@example.com",
      "dev@example.com",
      "ops@example.com",
    ]);
  });

  it("tokenNames lists the token names, deduplicated and sorted", () => {
    expect(tokenNames(parseWhoList(["token:uptime", "staff", "token:etl", "token:uptime"]))).toEqual(["etl", "uptime"]);
    expect(tokenNames(parseWhoList(["staff"]))).toEqual([]);
  });

  it("pathUnder matches segment by segment", () => {
    expect(pathUnder("/admin", "/admin")).toBe(true);
    expect(pathUnder("/admin/users", "/admin")).toBe(true);
    expect(pathUnder("/administrator", "/admin")).toBe(false);
    expect(pathUnder("/anything", "")).toBe(true);
    expect(pathUnder("", "/admin")).toBe(false);
  });
});

describe("accessFor", () => {
  /** A web section from a droplet file body (after name and ssh). */
  const webOf = async (body: string): Promise<DesiredWeb> => {
    const files = await exampleWith({ "droplets/x.example.com.yaml": `name: x.example.com\nssh: [admins]\nweb:\n${body}` });
    const r = loadInfraFiles(files);
    expect(r.diagnostics).toEqual([]);
    return desiredWeb(r.config!.droplets.find((d) => d.file.name === "x.example.com")!.file)!;
  };
  const pathOf = (r: ReturnType<typeof accessFor>): string => (r === "404" ? "404" : r.path);

  const open = () =>
    webOf(
      [
        "  hostnames: [x.example.net]",
        "  access:",
        "    /: [everyone]",
        "    /admin: [staff]",
        "    /admin/hook: [everyone]",
        "    /api: [token:uptime]",
        "    /api/public: [everyone]",
        "    /ops: [staff, token:etl]",
        "    /healthcheck/: [everyone]",
        "",
      ].join("\n"),
    );

  it("covers a path and everything under it, segment by segment", async () => {
    const w = await open();
    expect(pathOf(accessFor(w, "/admin", true))).toBe("/admin");
    expect(pathOf(accessFor(w, "/admin/", true))).toBe("/admin");
    expect(pathOf(accessFor(w, "/admin/users/1", true))).toBe("/admin");
    expect(pathOf(accessFor(w, "/administrator", true))).toBe("/");
    expect(pathOf(accessFor(w, "/", true))).toBe("/");
    expect(pathOf(accessFor(w, "/shop/cart", true))).toBe("/");
  });

  it("compares without case and ignores the query string", async () => {
    const w = await open();
    expect(pathOf(accessFor(w, "/ADMIN/Users", true))).toBe("/admin");
    expect(pathOf(accessFor(w, "/admin?next=/x", true))).toBe("/admin");
    expect(pathOf(accessFor(w, "/administrator?x=/admin", true))).toBe("/");
  });

  it("picks the most specific path", async () => {
    const w = await open();
    expect(pathOf(accessFor(w, "/api/x", true))).toBe("/api");
    expect(pathOf(accessFor(w, "/api/public/x", true))).toBe("/api/public");
    expect(pathOf(accessFor(w, "/admin/hook/1", true))).toBe("/admin/hook");
    expect(accessFor(w, "/api/x", true)).toMatchObject({ who: [{ kind: "token", name: "uptime" }], needsLogin: false });
  });

  it('answers "404" on an extra hostname of an open site for a path that needs a login', async () => {
    const w = await open();
    expect(accessFor(w, "/admin/users", false)).toBe("404");
    expect(accessFor(w, "/ops", false)).toBe("404"); // a login among tokens still needs the login page
    expect(pathOf(accessFor(w, "/", false))).toBe("/");
    expect(pathOf(accessFor(w, "/api/x", false))).toBe("/api"); // tokens only: no login page
    expect(pathOf(accessFor(w, "/api/public", false))).toBe("/api/public");
    // The tunnel's 404 rule for /admin covers everything under it, an open path included
    // (src/checks warns about it: web-access-under-404); on the droplet's own name Access applies.
    expect(accessFor(w, "/admin/hook", false)).toBe("404");
    expect(pathOf(accessFor(w, "/admin/hook", true))).toBe("/admin/hook");
  });

  it("counts /healthcheck/ open to everyone only on the droplet's own name", async () => {
    const w = await open();
    expect(pathOf(accessFor(w, "/healthcheck/", true))).toBe("/healthcheck/");
    expect(pathOf(accessFor(w, "/healthcheck", true))).toBe("/healthcheck/");
    expect(pathOf(accessFor(w, "/healthcheck/", false))).toBe("/"); // falls back to its parent
  });

  it("on a site behind a login, gives extra hostnames the parent rule (never 404)", async () => {
    const w = await webOf("  hostnames: [x.example.net]\n  access:\n    /: [staff]\n    /admin: [admins]\n    /healthcheck/: [everyone]\n");
    expect(w.rootOpen).toBe(false);
    expect(accessFor(w, "/healthcheck/", false)).toMatchObject({ path: "/", who: [{ kind: "staff" }] });
    expect(pathOf(accessFor(w, "/healthcheck/", true))).toBe("/healthcheck/");
    expect(pathOf(accessFor(w, "/admin/x", false))).toBe("/admin");
  });
});
