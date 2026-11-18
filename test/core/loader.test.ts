import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "../../src/core/diagnostics.js";
import { loadInfraDir, loadInfraFiles, readInfraDir } from "../../src/core/loader.js";
import { EXAMPLE_DIR, exampleFiles, exampleWith, tempDir } from "../helpers.js";

const D = (name: string) => `droplets/${name}.yaml`;

async function loadWith(changes: Record<string, string | null>) {
  return loadInfraFiles(await exampleWith(changes));
}

function only(ds: Diagnostic[]): Diagnostic {
  const errs = ds.filter((d) => d.level === "error");
  expect(errs, JSON.stringify(errs, null, 2)).toHaveLength(1);
  return errs[0]!;
}

describe("loader: the example checkout", () => {
  it("loads with no diagnostics", async () => {
    const res = await loadInfraDir(EXAMPLE_DIR);
    expect(res.diagnostics).toEqual([]);
    const c = res.config!;
    expect(c.droplets.map((d) => d.file.name)).toEqual([
      "db.example.com",
      "shop.example.com",
      "staging-shop.example.com",
      "tools.example.net",
      "worker-2.example.com",
      "worker.example.com",
    ]);
    expect(Object.keys(c.profiles).sort()).toEqual(["ubuntu-4", "ubuntu-6"]);
    expect(c.profiles["ubuntu-6"]!.userDataText.startsWith("#cloud-config")).toBe(true);
  });

  it("parses and normalises values", async () => {
    const c = loadInfraFiles(await exampleFiles()).config!;
    const shop = c.droplets.find((d) => d.file.name === "shop.example.com")!.file;
    expect(shop.deploy).toBe(true);
    expect(shop.frozen).toBe(false);
    expect(shop.web!.exceptions[1]!.allow).toEqual({ ips: ["198.51.100.0/24", "203.0.113.9/32"], service_tokens: ["uptime"] });
    expect(shop.allow.droplet[0]!.ports[0]).toMatchObject({ from: 8080, to: 8080, protocol: "tcp" });

    const db = c.droplets.find((d) => d.file.name === "db.example.com")!.file;
    expect(db.frozen).toBe(true);
    expect(db.monitors).toEqual([]);
    expect(db.allow.tunnel[0]!.who).toEqual([{ kind: "service-token", name: "etl" }, { kind: "staff" }]);
    expect(db.allow.ip[0]!.from).toBe("192.0.2.10/32");

    const w2 = c.droplets.find((d) => d.file.name === "worker-2.example.com")!.file;
    expect(w2.swarm).toEqual({ cluster: "jobs", role: "worker", encrypted_overlay: false });
    expect(w2.allow.droplet).toEqual([]);
  });

  it("applies account defaults", async () => {
    const files = await exampleFiles();
    const acc = files["account.yaml"]!.replace(/  guards:\n.*\n.*\n/, "").replace(/  ssh_config_branch.*\n  ssh_config_file.*\n/, "").replace("  user: ubuntu\n", "");
    const c = loadInfraFiles({ ...files, "account.yaml": acc }).config!;
    expect(c.account.cloudflare.guards).toEqual({ max_deletes: 20, max_delete_fraction: 0.3 });
    expect(c.account.github).toEqual({ infra_repo: "example-org/infra", ssh_config_branch: "ssh-config", ssh_config_file: "ssh_config" });
    expect(c.account.ssh_config.user).toBe("ubuntu");
  });
});

describe("loader: droplet files", () => {
  it("requires name to equal the file name, with file, path and line", async () => {
    const res = await loadWith({ [D("shop.example.com")]: "env: prod\nname: shop2.example.com\nssh: [admins]\n" });
    expect(res.config).toBeUndefined();
    expect(only(res.diagnostics)).toMatchObject({ code: "file-name", file: D("shop.example.com"), path: "name", line: 2 });
  });

  it("names unknown keys with their path and line", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nweb:\n  exposure: staff\n  colour: blue\nssh: [admins]\n" });
    expect(only(res.diagnostics)).toMatchObject({ code: "schema", path: "web.colour", line: 4, message: 'unknown key "colour"' });
  });

  it("explains enum errors with the allowed values", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nenv: production\n" });
    expect(only(res.diagnostics)).toMatchObject({ path: "env", message: 'must be one of: "prod", "staging", "internal"' });
  });

  it("rejects a name that is not a lowercase domain", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: X.example.com\nssh: [admins]\n" });
    const errs = res.diagnostics.filter((d) => d.level === "error");
    expect(errs.some((d) => d.path === "name" && d.message.includes("lowercase domain"))).toBe(true);
  });

  it("requires env with a profile and with deploy", async () => {
    let res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nprofile: ubuntu-4\n" });
    expect(only(res.diagnostics).message).toContain("env is required when a profile is set");
    res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\ndeploy: true\n" });
    expect(only(res.diagnostics).message).toContain("env is required for a deploy target");
  });

  it("accepts a minimal adopted droplet", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\n" });
    expect(res.diagnostics).toEqual([]);
    const x = res.config!.droplets.find((d) => d.file.name === "x.example.com")!.file;
    expect(x).toEqual({ name: "x.example.com", deploy: false, frozen: false, ssh: ["admins"], allow: { droplet: [], tunnel: [], ip: [] } });
  });

  it("rejects ports without protocol and reversed ranges", async () => {
    let res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nallow:\n  droplet:\n    - from: shop.example.com\n      ports: [8443]\nssh: [admins]\n" });
    expect(only(res.diagnostics)).toMatchObject({ path: "allow.droplet[0].ports[0]", line: 5 });
    res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nallow:\n  ip:\n    - from: 192.0.2.1\n      ports: [9001-9000/tcp]\nssh: [admins]\n" });
    expect(only(res.diagnostics)).toMatchObject({ path: "allow.ip[0].ports[0]", message: expect.stringContaining("range end") });
  });

  it("rejects a tunnel route with a port range or a bad who", async () => {
    let res = await loadWith({
      [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nallow:\n  tunnel:\n    - route: x-api.example.com\n      port: 80-81/tcp\n      who: [staff]\n",
    });
    expect(only(res.diagnostics)).toMatchObject({ path: "allow.tunnel[0].port", message: expect.stringContaining("one port") });
    res = await loadWith({
      [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nallow:\n  tunnel:\n    - route: x-api.example.com\n      port: 80/tcp\n      who: [everyone]\n",
    });
    expect(only(res.diagnostics)).toMatchObject({ path: "allow.tunnel[0].who[0]" });
  });

  it("rejects invalid addresses", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nallow:\n  ip:\n    - from: 300.0.113.1\n      ports: [22/tcp]\n" });
    expect(only(res.diagnostics)).toMatchObject({ path: "allow.ip[0].from", message: expect.stringContaining("IP address or CIDR") });
  });

  it("rejects a droplet listing itself as a caller", async () => {
    const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nallow:\n  droplet:\n    - from: x.example.com\n      ports: [22/tcp]\n" });
    expect(only(res.diagnostics).path).toBe("allow.droplet[0].from");
  });

  describe("web", () => {
    const web = (body: string) => ({ [D("x.example.com")]: `name: x.example.com\nssh: [admins]\nweb:\n${body}` });

    it("rejects protected_paths on a staff site", async () => {
      const res = await loadWith(web("  exposure: staff\n  protected_paths: [/admin]\n"));
      expect(only(res.diagnostics)).toMatchObject({ path: "web", message: expect.stringContaining("only for exposure: public") });
    });

    it("rejects an exception that is also a protected path (default /admin included)", async () => {
      const res = await loadWith(web("  exposure: public\n  exceptions:\n    - path: /admin/\n      allow: everyone\n"));
      expect(only(res.diagnostics)).toMatchObject({ path: "web.exceptions[0].path", message: expect.stringContaining("both a protected path and an exception") });
    });

    it("rejects duplicate exception paths after normalising", async () => {
      const res = await loadWith(web("  exposure: staff\n  exceptions:\n    - path: /hook\n      allow: everyone\n    - path: /Hook/\n      allow: everyone\n"));
      expect(only(res.diagnostics)).toMatchObject({ path: "web.exceptions[1].path", message: expect.stringContaining("duplicate") });
    });

    it("explains a wrong exception allow", async () => {
      const res = await loadWith(web("  exposure: staff\n  exceptions:\n    - path: /hook\n      allow: anyone\n"));
      expect(only(res.diagnostics)).toMatchObject({ path: "web.exceptions[0].allow", message: expect.stringContaining('"everyone" or an object') });
    });

    it("rejects an empty allow object and an unknown allow key", async () => {
      let res = await loadWith(web("  exposure: staff\n  exceptions:\n    - path: /hook\n      allow: {}\n"));
      expect(only(res.diagnostics).path).toBe("web.exceptions[0].allow");
      res = await loadWith(web("  exposure: staff\n  exceptions:\n    - path: /hook\n      allow: {emails: [a@example.com]}\n"));
      expect(only(res.diagnostics).path).toBe("web.exceptions[0].allow");
    });

    it("rejects generated prefixes and the droplet's own name as extra hostnames", async () => {
      const res = await loadWith(web("  exposure: staff\n  hostnames: [ssh-x.example.com, x.example.com]\n"));
      const errs = res.diagnostics.filter((d) => d.level === "error").map((d) => d.path);
      expect(errs).toEqual(["web.hostnames[0]", "web.hostnames[1]"]);
    });

    it("rejects an origin with a path and a health path that isn't a path", async () => {
      let res = await loadWith(web("  exposure: staff\n  origin: http://{ip}:80/app\n"));
      expect(only(res.diagnostics).path).toBe("web.origin");
      res = await loadWith(web("  exposure: staff\n  health_path: healthcheck\n"));
      expect(only(res.diagnostics)).toMatchObject({ path: "web.health_path", message: expect.stringContaining("health_path must be") });
    });

    it("rejects monitors for hostnames the droplet doesn't serve, and monitors without web", async () => {
      let res = await loadWith(web("  exposure: staff\nmonitors:\n  - hostname: other.example.com\n"));
      expect(only(res.diagnostics).path).toBe("monitors[0].hostname");
      res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\nmonitors:\n  - hostname: x.example.com\n" });
      expect(only(res.diagnostics).message).toContain("need a web section");
    });
  });

  describe("YAML", () => {
    it("rejects duplicate keys with the line", async () => {
      const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nenv: prod\nenv: staging\nssh: [admins]\n" });
      expect(only(res.diagnostics)).toMatchObject({ code: "yaml", file: D("x.example.com"), line: 3 });
    });
    it("rejects several documents in one file", async () => {
      const res = await loadWith({ [D("x.example.com")]: "name: x.example.com\nssh: [admins]\n---\nname: y.example.com\n" });
      expect(only(res.diagnostics)).toMatchObject({ code: "yaml", message: expect.stringContaining("2 YAML documents") });
    });
    it("rejects an empty file and a non-object", async () => {
      let res = await loadWith({ [D("x.example.com")]: "" });
      expect(only(res.diagnostics).file).toBe(D("x.example.com"));
      res = await loadWith({ [D("x.example.com")]: "- a\n- b\n" });
      expect(only(res.diagnostics)).toMatchObject({ code: "schema", message: "must be object" });
    });
  });

  describe("layout", () => {
    it.each([
      ["droplets/x.example.com.yml"],
      ["droplets/X.example.com.yaml"],
      ["droplets/sub/x.example.com.yaml"],
      ["profiles/ubuntu-8.yml"],
    ])("rejects %s", async (path) => {
      const res = await loadWith({ [path]: "name: x.example.com\nssh: [admins]\n" });
      expect(only(res.diagnostics)).toMatchObject({ code: "layout", file: path });
    });
    it("ignores README.md and .gitkeep in data folders, and anything outside them", async () => {
      const res = await loadWith({ "droplets/README.md": "# hi", "droplets/.gitkeep": "", "README.md": "# repo", "notes/x.txt": "x" });
      expect(res.diagnostics).toEqual([]);
    });
    it("requires account.yaml", async () => {
      const res = await loadWith({ "account.yaml": null });
      expect(only(res.diagnostics)).toMatchObject({ file: "account.yaml", message: "missing" });
    });
  });
});

describe("loader: profiles", () => {
  it("requires the user_data file to exist and be cloud-config", async () => {
    let res = await loadWith({ "profiles/user-data/ubuntu.cloud-init": null });
    const errs = res.diagnostics.filter((d) => d.level === "error");
    expect(errs.map((d) => d.file).sort()).toEqual(["profiles/ubuntu-4.yaml", "profiles/ubuntu-6.yaml"]);
    res = await loadWith({ "profiles/user-data/ubuntu.cloud-init": "#!/bin/sh\necho hi\n" });
    expect(res.diagnostics.filter((d) => d.level === "error")[0]!.message).toContain("#cloud-config");
  });
  it("requires name to equal the file name", async () => {
    const res = await loadWith({ "profiles/ubuntu-4.yaml": "name: ubuntu-5\nsize: s-1vcpu-1gb\nimage: ubuntu-26-04-x64\nuser_data: ubuntu.cloud-init\n" });
    expect(only(res.diagnostics)).toMatchObject({ code: "file-name", file: "profiles/ubuntu-4.yaml", path: "name" });
  });
  it("warns about unused user-data files", async () => {
    const res = await loadWith({ "profiles/user-data/old.cloud-init": "#cloud-config\n" });
    expect(res.config).toBeDefined();
    expect(res.diagnostics).toEqual([expect.objectContaining({ level: "warning", code: "unused-user-data" })]);
  });
});

describe("loader: account.yaml", () => {
  it("requires CI deploy token names to exist and every env region to have a tunnel", async () => {
    const files = await exampleFiles();
    const acc = files["account.yaml"]!.replace("prod: [ci-prod]", "prod: [ci-nope]").replace("staging: blr1", "staging: sfo3");
    const res = loadInfraFiles({ ...files, "account.yaml": acc });
    const errs = res.diagnostics.filter((d) => d.level === "error");
    expect(errs.map((d) => [d.code, d.path])).toEqual([
      ["unknown-service-token", "cloudflare.ci_deploy_tokens.prod[0]"],
      ["region-without-tunnel", "digitalocean.regions.staging"],
    ]);
  });
  it("rejects malformed ids", async () => {
    const files = await exampleFiles();
    const acc = files["account.yaml"]!.replace("staff_policy_id: 00000000-0000-4000-8000-000000000010", "staff_policy_id: staff");
    const res = loadInfraFiles({ ...files, "account.yaml": acc });
    expect(only(res.diagnostics)).toMatchObject({ file: "account.yaml", path: "cloudflare.staff_policy_id", message: expect.stringContaining("UUID") });
  });
});

describe("readInfraDir", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("never follows symlinks", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await mkdir(join(t.dir, "droplets"));
    await writeFile(join(t.dir, "account.yaml"), "x: 1\n");
    await writeFile(join(t.dir, "outside.txt"), "not data\n");
    await symlink(join(t.dir, "outside.txt"), join(t.dir, "droplets", "x.example.com.yaml"));
    const { files, diagnostics } = await readInfraDir(t.dir);
    expect(files["droplets/x.example.com.yaml"]).toBeUndefined();
    expect(diagnostics).toEqual([expect.objectContaining({ code: "layout", file: "droplets/x.example.com.yaml", message: expect.stringContaining("symlink") })]);
  });

  it("reports a missing droplets folder", async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    await writeFile(join(t.dir, "account.yaml"), "x: 1\n");
    const { diagnostics } = await readInfraDir(t.dir);
    expect(diagnostics).toEqual([expect.objectContaining({ file: "droplets", message: "missing" })]);
  });
});
