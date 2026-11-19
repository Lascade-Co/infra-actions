// infra export (phase D): the Worker's state -> account.yaml + droplet files. Fake data only.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main } from "../../src/cli.js";
import { loadInfraDir } from "../../src/core/loader.js";
import { buildExport, type ExportInput } from "../../src/export/index.js";
import { parseExportArgs, parseWranglerVars } from "../../src/export/run.js";
import { observedDroplet, tempDir } from "../helpers.js";

const WRANGLER = `name = "sync"
[triggers]
crons = ["*/10 * * * *"]

[vars]
CF_ACCOUNT_ID = "0123456789abcdef0123456789abcdef"
TEAM_DOMAIN = "https://example.cloudflareaccess.com"
# a comment
TUNNELS_BY_REGION = '{"nyc1":"00000000-0000-4000-8000-000000000001","blr1":"00000000-0000-4000-8000-000000000002"}'
SSH_ADMIN_EMAILS = "Ops@example.com,admin@example.com"
CI_SERVICE_TOKEN_IDS = '{"prod":["00000000-0000-4000-8000-000000000101"],"staging":["00000000-0000-4000-8000-000000000102"],"internal":["00000000-0000-4000-8000-000000000101"]}'
DRY_RUN = "false"
MAX_DELETES = "20"
MAX_DELETE_FRACTION = "0.3"
STAFF_POLICY_ID = "00000000-0000-4000-8000-000000000010"
TELEGRAM_CHAT_ID = "-1000000000000"

[observability]
enabled = true
`;

const WEB_CONFIG = {
  sites: {
    "shop.example.com": {
      origin: "http://{ip}:80",
      hostnames: ["shop.example.net"],
      protected_paths: ["/admin", "/internal"],
      exceptions: [{ path: "/webhooks/payments", allow: "everyone" }],
      health_path: "/healthcheck/",
    },
    "tools.example.net": { protected_paths: ["/x"], health_path: "/status", health_accept_app_404: true, exceptions: [{ path: "/api", allow: { ips: ["198.51.100.0/24"] } }] },
    "legacy.example.com": { origin: "http://{ip}:80" },
    "gone.example.com": { origin: "http://{ip}:80" },
  },
};

const BASE = {
  cloudflare: { zones: ["example.com", "example.net"] },
  digitalocean: { regions: { prod: "nyc1", staging: "blr1", internal: "blr1" } },
  github: { infra_repo: "example-org/infra" },
  ssh_config: { title: "Example droplets" },
};

const DROPLETS = [
  observedDroplet("shop.example.com", { id: 1, privateIpv4: "10.0.0.11", tags: ["env-prod", "ci-deploy", "web-public", "production"] }),
  observedDroplet("tools.example.net", { id: 2, region: "blr1", privateIpv4: "10.0.0.12", tags: ["env-internal", "web-staff"] }),
  observedDroplet("db.example.com", { id: 3, privateIpv4: "10.0.0.13", tags: ["production"] }),
  observedDroplet("worker.example.com", { id: 4, privateIpv4: "10.0.0.14", tags: ["env-prod"] }),
  observedDroplet("legacy.example.com", { id: 5, privateIpv4: "10.0.0.15", tags: ["env-prod", "ci-deploy"] }),
  observedDroplet("quiet.example.com", { id: 6, privateIpv4: "10.0.0.16", tags: [] }),
  observedDroplet("far.example.com", { id: 7, region: "sgp1", privateIpv4: "10.0.0.17", tags: ["env-prod"] }),
  observedDroplet("build-box", { id: 8, tags: ["dev"] }),
  observedDroplet("both.example.com", { id: 9, privateIpv4: "10.0.0.19", tags: ["web-staff", "web-public"] }),
];

const DRAFTS = {
  droplets: {
    "db.example.com": {
      allow: {
        droplet: [
          { from: "shop.example.com", ports: ["5432/tcp"] },
          { from: "build-box", ports: ["5432/tcp"], note: "unmanaged caller: dropped" },
        ],
        ip: [{ from: "192.0.2.10", ports: ["5432/tcp"] }],
      },
    },
    "worker.example.com": { swarm: { cluster: "jobs" } },
    "nobody.example.com": { allow: { ip: [{ from: "192.0.2.11", ports: ["22/tcp"] }] } },
  },
};

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    droplets: DROPLETS,
    vars: parseWranglerVars(WRANGLER),
    webConfig: WEB_CONFIG,
    base: BASE,
    drafts: DRAFTS,
    frozen: ["db.example.com"],
    date: "2026-11-19",
    ...over,
  };
}

const doc = (files: Record<string, string>, rel: string) => parse(files[rel]!) as Record<string, unknown>;

describe("parseWranglerVars", () => {
  it("reads [vars] only, both string kinds", () => {
    const v = parseWranglerVars(WRANGLER);
    expect(v.TEAM_DOMAIN).toBe("https://example.cloudflareaccess.com");
    expect(JSON.parse(v.TUNNELS_BY_REGION!)).toHaveProperty("blr1");
    expect(v).not.toHaveProperty("crons");
    expect(v).not.toHaveProperty("enabled");
  });
  it("refuses a line it can't read", () => {
    expect(() => parseWranglerVars("[vars]\nX = 3\n")).toThrow(/can't read/);
  });
});

describe("buildExport", () => {
  it("writes the account from the Worker's vars and the base", () => {
    const { files } = buildExport(input());
    const a = doc(files, "account.yaml") as { cloudflare: Record<string, unknown>; ssh_groups: Record<string, string[]>; telegram: unknown; ssh_email_domain: string };
    expect(a.cloudflare.tunnels).toEqual({ nyc1: "00000000-0000-4000-8000-000000000001", blr1: "00000000-0000-4000-8000-000000000002" });
    expect(a.cloudflare.service_tokens).toEqual({ "ci-prod": "00000000-0000-4000-8000-000000000101", "ci-staging": "00000000-0000-4000-8000-000000000102" });
    expect(a.cloudflare.ci_deploy_tokens).toEqual({ prod: ["ci-prod"], staging: ["ci-staging"], internal: ["ci-prod"] });
    expect(a.cloudflare.guards).toEqual({ max_deletes: 20, max_delete_fraction: 0.3 });
    expect(a.ssh_groups).toEqual({ admins: ["admin@example.com", "ops@example.com"] });
    expect(a.ssh_email_domain).toBe("example.com");
    expect(a.telegram).toEqual({ chat_id: "-1000000000000" });
  });

  it("keeps token names from the base and prefers API zones", () => {
    const base = { ...BASE, cloudflare: { zones: ["example.com"], service_tokens: { deploy: "00000000-0000-4000-8000-000000000101" } } };
    const { files } = buildExport(input({ base, zones: ["Example.com", "example.net"] }));
    const cf = doc(files, "account.yaml").cloudflare as Record<string, unknown>;
    expect(cf.zones).toEqual(["example.com", "example.net"]);
    expect(cf.ci_deploy_tokens).toEqual({ prod: ["deploy"], staging: ["ci-staging"], internal: ["deploy"] });
  });

  it("writes one file per droplet the Worker manages, from its tags and web-config.json", () => {
    const { files, notes } = buildExport(input());
    expect(notes.written).toEqual(["both.example.com", "db.example.com", "legacy.example.com", "shop.example.com", "tools.example.net", "worker.example.com"]);
    expect(doc(files, "droplets/shop.example.com.yaml")).toEqual({
      name: "shop.example.com",
      env: "prod",
      deploy: true,
      ssh: ["admins"],
      web: {
        exposure: "public",
        origin: "http://{ip}:80",
        hostnames: ["shop.example.net"],
        protected_paths: ["/admin", "/internal"],
        exceptions: [{ path: "/webhooks/payments", allow: "everyone" }],
        health_path: "/healthcheck/",
      },
    });
    // staff: protected_paths dropped (the Worker ignores them), the rest kept
    expect(doc(files, "droplets/tools.example.net.yaml").web).toEqual({
      exposure: "staff",
      exceptions: [{ path: "/api", allow: { ips: ["198.51.100.0/24"] } }],
      health_path: "/status",
      health_accept_app_404: true,
    });
    // no env tag: no env; no web tag: no web, even with a web-config.json entry
    expect(doc(files, "droplets/legacy.example.com.yaml")).toEqual({ name: "legacy.example.com", env: "prod", deploy: true, ssh: ["admins"] });
    expect(doc(files, "droplets/db.example.com.yaml")).toMatchObject({ name: "db.example.com", frozen: true, ssh: ["admins"] });
    expect(doc(files, "droplets/db.example.com.yaml")).not.toHaveProperty("env");
    expect(doc(files, "droplets/both.example.com.yaml")).not.toHaveProperty("web");
    expect(files["droplets/db.example.com.yaml"]).toMatch(/^# yaml-language-server: \$schema=/);
  });

  it("notes what it leaves out", () => {
    const { notes } = buildExport(input());
    expect(notes.leftOut).toEqual([{ name: "quiet.example.com", reason: expect.stringContaining("no tags") }]);
    expect(notes.notManaged.map((n) => n.name).sort()).toEqual(["build-box", "far.example.com"]);
    expect(notes.webNotWritten.map((n) => n.name).sort()).toEqual(["gone.example.com", "legacy.example.com", "tools.example.net"]);
    expect(notes.warnings.join("\n")).toContain("both.example.com: tagged both");
  });

  it("includes untagged droplets when asked", () => {
    const { notes } = buildExport(input({ includeUntagged: true }));
    expect(notes.written).toContain("quiet.example.com");
    expect(notes.leftOut).toEqual([]);
  });

  it("adds drafts under a DRAFT comment and drops the entries the checks reject", () => {
    const { files, notes } = buildExport(input());
    const db = files["droplets/db.example.com.yaml"]!;
    expect(db).toContain("# DRAFT from server-to-server-map.md");
    expect(doc(files, "droplets/db.example.com.yaml").allow).toEqual({
      droplet: [{ from: "shop.example.com", ports: ["5432/tcp"] }],
      ip: [{ from: "192.0.2.10", ports: ["5432/tcp"] }],
    });
    // a swarm with no manager is a check error: dropped
    expect(doc(files, "droplets/worker.example.com.yaml")).not.toHaveProperty("swarm");
    const dropped = notes.draftsDropped.map((n) => `${n.name} ${n.reason}`);
    expect(dropped).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^db\.example\.com allow\.droplet .*build-box.*unknown-droplet|^db\.example\.com allow\.droplet .*build-box/),
        expect.stringMatching(/^worker\.example\.com swarm .*swarm-no-manager/),
        expect.stringMatching(/^nobody\.example\.com drafts for a droplet that gets no file/),
      ]),
    );
  });
});

describe("infra export (cli)", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  it("parses its arguments", () => {
    expect(parseExportArgs(["out", "--worker", "w", "--web-config", "c", "--frozen", "a, b", "--include-untagged"])).toMatchObject({
      outDir: "out",
      frozen: ["a", "b"],
      includeUntagged: true,
    });
    expect(parseExportArgs(["out", "--worker", "w"])).toHaveProperty("error");
    expect(parseExportArgs(["out", "--worker", "w", "--web-config", "c", "--nope", "x"])).toHaveProperty("error");
  });

  it("writes a checkout that loads, removes stale droplet files, prints one line with no names", async () => {
    const out = join(dir, "infra");
    await mkdir(join(out, "droplets"), { recursive: true });
    await writeFile(join(out, "droplets", "stale.example.com.yaml"), "name: stale.example.com\n");
    await writeFile(join(out, "droplets", ".gitkeep"), "");
    await writeFile(join(dir, "wrangler.toml"), WRANGLER);
    await writeFile(join(dir, "web-config.json"), JSON.stringify(WEB_CONFIG));
    await writeFile(join(dir, "base.yaml"), JSON.stringify(BASE));
    await writeFile(join(dir, "drafts.yaml"), JSON.stringify(DRAFTS));
    // doctl's shape: API droplet objects; one without "tags" (doctl leaves out empty tags)
    const api = DROPLETS.map((d) => ({
      id: d.id,
      name: d.name,
      status: "active",
      region: { slug: d.region },
      ...(d.tags.length ? { tags: d.tags } : {}),
      networks: { v4: d.privateIpv4 ? [{ ip_address: d.privateIpv4, type: "private" }] : [] },
    }));
    await writeFile(join(dir, "droplets.json"), JSON.stringify(api));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await main(
      ["export", out, "--worker", join(dir, "wrangler.toml"), "--web-config", join(dir, "web-config.json"), "--droplets", join(dir, "droplets.json"),
        "--account-base", join(dir, "base.yaml"), "--drafts", join(dir, "drafts.yaml"), "--frozen", "db.example.com", "--date", "2026-11-19", "--out", join(dir, "notes.md")],
      { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: {}, fetch: async () => { throw new Error("no network"); } },
    );
    expect(stderr).toEqual([]);
    expect(code).toBe(0);
    expect(stdout).toEqual([expect.stringMatching(/^infra export: droplet files 6 \| left out 1 \| .* stale files removed 1$/)]);
    expect(stdout[0]).not.toMatch(/example\.|10\.0\.0\./);
    expect((await readdir(join(out, "droplets"))).sort()).toEqual([
      ".gitkeep",
      "both.example.com.yaml",
      "db.example.com.yaml",
      "legacy.example.com.yaml",
      "shop.example.com.yaml",
      "tools.example.net.yaml",
      "worker.example.com.yaml",
    ]);
    const loaded = await loadInfraDir(out);
    expect(loaded.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(await readFile(join(dir, "notes.md"), "utf8")).toContain("quiet.example.com");

    // A re-export takes the account base from the checkout's own account.yaml.
    const again = await main(
      ["export", out, "--worker", join(dir, "wrangler.toml"), "--web-config", join(dir, "web-config.json"), "--droplets", join(dir, "droplets.json"), "--date", "2026-11-19"],
      { stdout: () => {}, stderr: (l) => stderr.push(l), env: {}, fetch: async () => { throw new Error("no network"); } },
    );
    expect(again).toBe(0);
  });

  it("fails without printing details when an input is missing", async () => {
    const stderr: string[] = [];
    const code = await main(["export", join(dir, "x"), "--worker", join(dir, "none.toml"), "--web-config", join(dir, "none.json")], {
      stdout: () => {},
      stderr: (l) => stderr.push(l),
      env: {},
      fetch: async () => { throw new Error("no network"); },
    });
    expect(code).toBe(1);
    expect(stderr).toEqual(["infra export: failed; pass --out <file> to see the details"]);
  });
});
