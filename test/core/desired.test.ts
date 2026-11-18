import { describe, expect, it } from "vitest";
import { buildDesired } from "../../src/core/desired.js";
import { loadInfraFiles } from "../../src/core/loader.js";
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

  it("writes only the managed tags", async () => {
    const d = buildDesired(await example(), existing);
    const tags = Object.fromEntries(d.droplets.map((x) => [x.name, x.tags]));
    expect(tags["shop.example.com"]).toEqual(["ci-deploy", "env-prod", "web-public"]);
    expect(tags["staging-shop.example.com"]).toEqual(["ci-deploy", "env-staging", "web-staff"]);
    expect(tags["db.example.com"]).toEqual(["env-prod"]);
  });

  it("applies web defaults the way the Worker does", async () => {
    const files = await exampleWith({
      "droplets/a.example.com.yaml": "name: a.example.com\nssh: [admins]\nweb:\n  exposure: public\n",
      "droplets/b.example.com.yaml": "name: b.example.com\nssh: [admins]\nenv: prod\ndeploy: true\nweb:\n  exposure: staff\n  hostnames: [b.example.net]\n",
    });
    const d = buildDesired(loadInfraFiles(files).config!, [observedDroplet("a.example.com"), observedDroplet("b.example.com")]);
    const a = d.droplets.find((x) => x.name === "a.example.com")!;
    expect(a.web).toMatchObject({ tag: "web-public", origin: "https://{ip}:443", protectedPaths: ["/admin"], healthPath: "/", hostnames: ["a.example.com"] });
    const b = d.droplets.find((x) => x.name === "b.example.com")!;
    expect(b.web).toMatchObject({ tag: "web-staff", protectedPaths: [], healthPath: "/healthcheck/", hostnames: ["b.example.com", "b.example.net"] });
    expect(b.monitors).toEqual([
      { type: "http", hostname: "b.example.com", path: "/healthcheck/", acceptApp404: false },
      { type: "http", hostname: "b.example.net", path: "/healthcheck/", acceptApp404: false },
    ]);
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
