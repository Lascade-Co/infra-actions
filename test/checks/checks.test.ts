import { describe, expect, it } from "vitest";
import { checkChange, checkConfig, checkDesired } from "../../src/checks/index.js";
import { buildDesired } from "../../src/core/desired.js";
import type { Diagnostic } from "../../src/core/diagnostics.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import type { InfraConfig } from "../../src/core/model.js";
import type { ObservedDroplet } from "../../src/core/observed.js";
import { exampleWith, observedDroplet } from "../helpers.js";

async function config(changes: Record<string, string | null> = {}): Promise<InfraConfig> {
  const r = loadInfraFiles(await exampleWith(changes));
  if (!r.config) throw new Error(`fixture does not load: ${JSON.stringify(r.diagnostics)}`);
  return r.config;
}

const f = (name: string) => `droplets/${name}.yaml`;
const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);
const pick = (ds: Diagnostic[]) => ds.map(({ level, code, file, path, droplet }) => ({ level, code, file, path, droplet }));

/** Every droplet of the example checkout that has no profile exists; the two with profiles don't yet. */
const EXISTING: ObservedDroplet[] = [
  observedDroplet("db.example.com", { id: 1, privateIpv4: "10.0.0.11", publicIpv4: "203.0.113.11" }),
  observedDroplet("shop.example.com", { id: 2, privateIpv4: "10.0.0.12", publicIpv4: "203.0.113.12" }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13", publicIpv4: "203.0.113.13" }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14", publicIpv4: "198.51.100.14" }),
];

describe("checkConfig", () => {
  it("passes the example checkout", async () => {
    expect(checkConfig(await config())).toEqual([]);
  });

  it("reports a name outside the account zones and flattened-name collisions", async () => {
    const c = await config({
      "droplets/build.example.org.yaml": "name: build.example.org\n",
      "droplets/a.b.example.com.yaml": "name: a.b.example.com\n",
      "droplets/a-b.example.com.yaml": "name: a-b.example.com\n",
    });
    const ds = checkConfig(c);
    expect(pick(ds)).toEqual([
      { level: "error", code: "name-collision", file: f("a.b.example.com"), path: "name", droplet: "a.b.example.com" },
      { level: "error", code: "naming", file: f("build.example.org"), path: "name", droplet: "build.example.org" },
    ]);
    expect(ds[0]!.message).toContain("ssh-a-b.example.com");
    expect(ds[1]!.message).toContain("not a domain in any account zone");
  });

  it("allows a multi-level droplet name without a site, but not as a site hostname", async () => {
    expect(checkConfig(await config({ "droplets/staging.app.example.com.yaml": "name: staging.app.example.com\n" }))).toEqual([]);
    const ds = checkConfig(await config({ "droplets/staging.app.example.com.yaml": "name: staging.app.example.com\nweb:\n  exposure: staff\n" }));
    expect(pick(ds)).toEqual([{ level: "error", code: "not-one-level", file: f("staging.app.example.com"), path: "name", droplet: "staging.app.example.com" }]);
    expect(ds[0]!.message).toContain("Use staging-app.example.com");
  });

  it("requires one-level hostnames and routes in an account zone", async () => {
    const ds = checkConfig(
      await config({
        "droplets/app.example.com.yaml": [
          "name: app.example.com",
          "web:",
          "  exposure: staff",
          "  hostnames: [x.y.example.net, app.example.org]",
          "allow:",
          "  tunnel:",
          "    - route: pg.app.example.com",
          "      port: 5432/tcp",
          "      who: [staff]",
        ].join("\n"),
      }),
    );
    expect(pick(ds).map((d) => [d.code, d.path])).toEqual([
      ["not-one-level", "web.hostnames[0]"],
      ["not-in-zone", "web.hostnames[1]"],
      ["not-one-level", "allow.tunnel[0].route"],
    ]);
  });

  it("rejects a hostname or route claimed twice or equal to another droplet's name", async () => {
    const ds = checkConfig(
      await config({
        "droplets/app.example.com.yaml": [
          "name: app.example.com",
          "web:",
          "  exposure: public",
          "  hostnames: [shop.example.net, tools.example.net]",
          "allow:",
          "  tunnel:",
          "    - route: db-etl.example.com",
          "      port: 5432/tcp",
          "      who: [staff]",
        ].join("\n"),
      }),
    );
    // Sorted by the contested name; a name claimed twice is reported on both files, a droplet's own name always wins.
    expect(pick(ds).map((d) => [d.code, d.file, d.path])).toEqual([
      ["hostname-claimed", f("app.example.com"), "allow.tunnel[0].route"],
      ["hostname-claimed", f("db.example.com"), "allow.tunnel[0].route"],
      ["hostname-claimed", f("app.example.com"), "web.hostnames[0]"],
      ["hostname-claimed", f("shop.example.com"), "web.hostnames[0]"],
      ["hostname-claimed", f("app.example.com"), "web.hostnames[1]"],
    ]);
    expect(ds[0]!.message).toBe(
      "db-etl.example.com is claimed more than once (a tunnel route in droplets/db.example.com.yaml (allow.tunnel[0].route)); a name can be served by one droplet only",
    );
    expect(ds[4]!.message).toBe("tools.example.net is the name of droplet tools.example.net; it can't also be a site hostname here");
  });

  it("reports unknown profiles, callers and service tokens with the exact field", async () => {
    const ds = checkConfig(
      await config({
        "droplets/app.example.com.yaml": [
          "name: app.example.com",
          "profile: ubuntu-99",
          "env: prod",
          "web:",
          "  exposure: public",
          "  exceptions:",
          "    - path: /api",
          "      allow:",
          "        service_tokens: [nope]",
          "allow:",
          "  droplet:",
          "    - from: ghost.example.com",
          "      ports: [80/tcp]",
          "  tunnel:",
          "    - route: app-db.example.com",
          "      port: 5432/tcp",
          "      who: [staff, service-token:missing]",
        ].join("\n"),
      }),
    );
    expect(pick(ds)).toEqual([
      { level: "error", code: "unknown-profile", file: f("app.example.com"), path: "profile", droplet: "app.example.com" },
      { level: "error", code: "unknown-droplet", file: f("app.example.com"), path: "allow.droplet[0].from", droplet: "app.example.com" },
      { level: "error", code: "unknown-service-token", file: f("app.example.com"), path: "allow.tunnel[0].who[1]", droplet: "app.example.com" },
      { level: "error", code: "unknown-service-token", file: f("app.example.com"), path: "web.exceptions[0].allow.service_tokens", droplet: "app.example.com" },
    ]);
    expect(ds[0]!.message).toContain("available: ubuntu-4, ubuntu-6");
    expect(ds[1]!.message).toContain("ghost.example.com has no droplet file (droplets/ghost.example.com.yaml)");
    expect(ds[2]!.message).toContain('service token "missing" is not in account.yaml cloudflare.service_tokens');
  });

  it("warns when a deploy target's environment has no CI token", async () => {
    const files = await exampleWith({});
    files["account.yaml"] = files["account.yaml"]!.replace("staging: [ci-staging]", "staging: []");
    const c = loadInfraFiles(files).config!;
    const ds = checkConfig(c);
    expect(pick(ds)).toEqual([{ level: "warning", code: "no-deploy-token", file: f("staging-shop.example.com"), path: "deploy", droplet: "staging-shop.example.com" }]);
  });

  it("accepts /udp only with who: [staff], and says why", async () => {
    const tunnel = (who: string) =>
      ["name: app.example.com", "allow:", "  tunnel:", "    - route: app-m.example.com", "      port: 9100/udp", `      who: ${who}`].join("\n");
    expect(checkConfig(await config({ "droplets/app.example.com.yaml": tunnel("[staff]") }))).toEqual([]);
    for (const who of ["[service-token:etl]", "[staff, service-token:etl]"]) {
      const ds = checkConfig(await config({ "droplets/app.example.com.yaml": tunnel(who) }));
      expect(pick(ds)).toEqual([{ level: "error", code: "udp-needs-staff", file: f("app.example.com"), path: "allow.tunnel[0].port", droplet: "app.example.com" }]);
      expect(ds[0]!.message).toContain("Service tokens are TCP only");
      expect(ds[0]!.message).toContain("private-network route");
    }
  });

  it("needs a manager in every swarm cluster", async () => {
    const ds = checkConfig(await config({ "droplets/worker.example.com.yaml": "name: worker.example.com\nenv: prod\nswarm:\n  cluster: jobs\n" }));
    expect(pick(ds).map((d) => [d.code, d.file, d.path])).toEqual([
      ["swarm-no-manager", f("worker-2.example.com"), "swarm.role"],
      ["swarm-no-manager", f("worker.example.com"), "swarm.role"],
    ]);
    expect(ds[0]!.message).toContain('swarm cluster "jobs" has no manager (members: worker-2.example.com, worker.example.com)');
  });

  it("needs swarm members to agree on encrypted_overlay (reported on the minority)", async () => {
    const ds = checkConfig(
      await config({
        "droplets/worker-2.example.com.yaml": "name: worker-2.example.com\nprofile: ubuntu-4\nenv: prod\nswarm:\n  cluster: jobs\n  encrypted_overlay: true\n",
        "droplets/worker-3.example.com.yaml": "name: worker-3.example.com\nenv: prod\nswarm:\n  cluster: jobs\n",
      }),
    );
    expect(pick(ds).map((d) => [d.code, d.file, d.path])).toEqual([["swarm-overlay-mismatch", f("worker-2.example.com"), "swarm.encrypted_overlay"]]);
    expect(ds[0]!.message).toContain("true in worker-2.example.com; false in worker-3.example.com, worker.example.com");
  });
});

describe("checkDesired", () => {
  it("only notes nothing unusual for the example checkout", async () => {
    expect(checkDesired(buildDesired(await config(), EXISTING))).toEqual([]);
  });

  it("warns that a cross-region caller's PUBLIC IP will be allowed", async () => {
    const c = await config({
      "droplets/db.example.com.yaml": "name: db.example.com\nenv: prod\nallow:\n  droplet:\n    - from: tools.example.net\n      ports: [5432/tcp]\n",
    });
    const ds = checkDesired(buildDesired(c, EXISTING));
    expect(pick(ds)).toEqual([{ level: "warning", code: "cross-region-caller", file: f("db.example.com"), path: "allow.droplet[0].from", droplet: "db.example.com" }]);
    expect(ds[0]!.message).toContain("tools.example.net is in blr1 and db.example.com is in nyc1");
    expect(ds[0]!.message).toContain("PUBLIC IP (198.51.100.14) on 5432/tcp");
  });

  it("says a new cross-region caller's public IP is known after create", async () => {
    const c = await config({
      "droplets/db.example.com.yaml": "name: db.example.com\nenv: prod\nallow:\n  droplet:\n    - from: staging-shop.example.com\n      ports: [5432/tcp]\n",
    });
    const ds = checkDesired(buildDesired(c, EXISTING));
    expect(ds[0]!.message).toContain("PUBLIC IP (known after create)");
  });

  it("notes a profile on a droplet that already exists", async () => {
    const ds = checkDesired(buildDesired(await config(), [...EXISTING, observedDroplet("worker-2.example.com", { id: 5 })]));
    expect(pick(ds)).toEqual([{ level: "info", code: "profile-ignored", file: f("worker-2.example.com"), path: "profile", droplet: "worker-2.example.com" }]);
    expect(ds[0]!.message).toContain("create-only");
  });

  it("warns about a droplet in a region with no tunnel", async () => {
    const obs = EXISTING.map((d) => (d.name === "shop.example.com" ? { ...d, region: "fra1" } : d));
    const ds = checkDesired(buildDesired(await config(), obs));
    expect(pick(ds)).toContainEqual({ level: "warning", code: "region-without-tunnel", file: f("shop.example.com"), path: undefined, droplet: "shop.example.com" });
    expect(ds.find((d) => d.code === "region-without-tunnel")!.message).toContain("region fra1, which has no tunnel in account.yaml cloudflare.tunnels");
  });

  it("requires swarm members to share one region", async () => {
    const c = await config({ "droplets/worker-3.example.com.yaml": "name: worker-3.example.com\nswarm:\n  cluster: jobs\n" });
    const obs = [...EXISTING, observedDroplet("worker-3.example.com", { id: 6, region: "blr1" })];
    const ds = checkDesired(buildDesired(c, obs));
    expect(pick(ds)).toEqual([{ level: "error", code: "swarm-region", file: f("worker-3.example.com"), path: "swarm.cluster", droplet: "worker-3.example.com" }]);
    expect(ds[0]!.message).toContain("nyc1 (worker-2.example.com, worker.example.com); blr1 (worker-3.example.com)");
  });

  it("ignores missing droplets and unknown callers (other checks report them)", async () => {
    const c = await config({
      "droplets/db.example.com.yaml": "name: db.example.com\nallow:\n  droplet:\n    - from: shop.example.com\n      ports: [5432/tcp]\n",
    });
    // db is missing in DigitalOcean (desired reports droplet-not-found); nothing to add here.
    expect(checkDesired(buildDesired(c, EXISTING.filter((d) => d.name !== "db.example.com")))).toEqual([]);
  });
});

describe("checkChange", () => {
  it("is silent when nothing was removed", async () => {
    const c = await config();
    expect(checkChange(c, c, buildDesired(c, EXISTING))).toEqual([]);
  });

  it("fails a removed droplet file while the droplet still exists in DigitalOcean (decision 15)", async () => {
    const base = await config();
    const head = await config({ "droplets/tools.example.net.yaml": null });
    const ds = checkChange(base, head, buildDesired(head, EXISTING));
    expect(pick(ds)).toEqual([{ level: "error", code: "removed-droplet-exists", file: f("tools.example.net"), path: undefined, droplet: "tools.example.net" }]);
    expect(ds[0]!.message).toContain("(id 4, blr1) still exists in DigitalOcean");
    expect(ds[0]!.message).toContain("delete the droplet by hand first, then remove its file");
  });

  it("warns what a removal cleans up once the droplet is gone", async () => {
    const base = await config();
    const head = await config({ "droplets/tools.example.net.yaml": null });
    const ds = checkChange(base, head, buildDesired(head, EXISTING.filter((d) => d.name !== "tools.example.net")));
    expect(pick(ds)).toEqual([{ level: "warning", code: "droplet-file-removed", file: f("tools.example.net"), path: undefined, droplet: "tools.example.net" }]);
    expect(ds[0]!.message).toContain("SSH route, private name, site");
  });

  it("fails removing a droplet that other files still list as a caller, naming each field", async () => {
    const base = await config();
    const head = await config({ "droplets/shop.example.com.yaml": null });
    const ds = checkChange(base, head, buildDesired(head, EXISTING.filter((d) => d.name !== "shop.example.com")));
    expect(codes(ds)).toEqual(["removed-droplet-referenced", "droplet-file-removed"]);
    expect(ds[0]!.message).toContain("droplets/db.example.com.yaml allow.droplet[0].from");
  });

  it("fails safe when the droplets could not be read", async () => {
    const base = await config();
    const head = await config({ "droplets/tools.example.net.yaml": null });
    const ds = checkChange(base, head, undefined);
    expect(pick(ds)).toEqual([{ level: "error", code: "removed-droplet-unverified", file: f("tools.example.net"), path: undefined, droplet: "tools.example.net" }]);
  });

  it("treats a renamed file as a removal: the old droplet must be renamed or deleted first", async () => {
    const base = await config();
    const head = await config({ "droplets/tools.example.net.yaml": null, "droplets/tools2.example.net.yaml": "name: tools2.example.net\n" });
    expect(codes(checkChange(base, head, buildDesired(head, EXISTING)))).toEqual(["removed-droplet-exists"]);
  });

  it("notes a changed profile on an existing droplet, but not on one still to be created", async () => {
    const base = await config();
    const head = await config({
      "droplets/shop.example.com.yaml": (await exampleWith({}))["droplets/shop.example.com.yaml"]!.replace("env: prod", "profile: ubuntu-6\nenv: prod"),
      "droplets/worker-2.example.com.yaml": "name: worker-2.example.com\nprofile: ubuntu-6\nenv: prod\nswarm:\n  cluster: jobs\n",
    });
    const ds = checkChange(base, head, buildDesired(head, EXISTING));
    expect(pick(ds)).toEqual([{ level: "info", code: "profile-changed", file: f("shop.example.com"), path: "profile", droplet: "shop.example.com" }]);
    expect(ds[0]!.message).toContain("from (none) to ubuntu-6");
  });
});
