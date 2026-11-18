import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseArgs, type CliIO } from "../src/cli.js";
import { exampleFiles, EXAMPLE_DIR, observedDroplet, tempDir } from "./helpers.js";
import { fakeModules } from "./fakes.js";

const SECRETS = {
  CF_API_TOKEN: "cf-secret-value-0001",
  DO_TOKEN: "do-secret-value-0002",
  INFRA_GH_TOKEN: "gh-secret-value-0003",
  ONEUPTIME_API_KEY: "ou-secret-value-0004",
  ONEUP_ACCESS_CLIENT_ID: "ou-client-id-0005",
  ONEUP_ACCESS_CLIENT_SECRET: "ou-client-secret-0006",
  TELEGRAM_BOT_TOKEN: "tg-secret-value-0007",
};

const DROPLETS = [
  observedDroplet("shop.example.com", { id: 1, privateIpv4: "10.0.0.11", publicIpv4: "203.0.113.11" }),
  observedDroplet("db.example.com", { id: 2, privateIpv4: "10.0.0.12" }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13" }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14" }),
  observedDroplet("build-box", { id: 5, publicIpv4: "198.51.100.5" }),
];

/** Every string from the fixtures that must never reach stdout/stderr. */
async function sensitiveStrings(): Promise<string[]> {
  const out = new Set<string>(Object.values(SECRETS));
  for (const d of DROPLETS) {
    out.add(d.name);
    if (d.privateIpv4) out.add(d.privateIpv4);
    if (d.publicIpv4) out.add(d.publicIpv4);
  }
  const text = Object.values(await exampleFiles()).join("\n");
  for (const m of text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.example\.(?:com|net)/g)) out.add(m[0]);
  for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) out.add(m[0]);
  for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) out.add(m[0]);
  out.add("0123456789abcdef0123456789abcdef");
  return [...out];
}

describe("cli", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(async () => {
    await cleanup();
  });

  function io(over: Partial<CliIO> = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const base: CliIO = {
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
      env: { ...SECRETS },
      fetch: async () => {
        throw new Error("no network in tests");
      },
      modules: fakeModules({ droplets: DROPLETS }).modules,
      now: () => new Date("2026-11-19T00:00:00Z"),
      sleep: async () => {},
      ...over,
    };
    return { io: base, stdout, stderr };
  }

  it.each(["check", "apply", "drift", "validate"])("%s prints one line of counts and nothing sensitive", async (cmd) => {
    const { io: x, stdout, stderr } = io();
    const out = join(dir, "report.md");
    const json = join(dir, "report.json");
    const code = await main([cmd, EXAMPLE_DIR, "--out", out, "--json", json, "--commit", "0123abc"], x);
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stderr).toEqual([]);
    const printed = stdout.join("\n");
    for (const s of await sensitiveStrings()) expect(printed, s).not.toContain(s);
    expect(printed).toMatch(new RegExp(`^infra ${cmd}: PASS \\| droplet files 6 \\| plan create \\d+ update \\d+ delete \\d+ report \\d+ \\| errors 0 warnings 0 \\| unmanaged droplets \\d+`));

    // The detail files carry the names (they go to the private PR comment), never secret values.
    const detail = await readFile(out, "utf8");
    const report = await readFile(json, "utf8");
    if (cmd !== "validate") expect(detail).toContain("shop.example.com");
    for (const v of Object.values(SECRETS)) {
      expect(detail).not.toContain(v);
      expect(report).not.toContain(v);
    }
  });

  it("keeps validation errors out of stdout and stderr", async () => {
    const t = await tempDir();
    try {
      const { cp, writeFile } = await import("node:fs/promises");
      await cp(EXAMPLE_DIR, t.dir, { recursive: true });
      await writeFile(join(t.dir, "droplets", "secret-host.example.com.yaml"), "name: other-secret-host.example.com\nallow:\n  ip:\n    - from: 192.0.2.77\n      ports: [22]\n");
      const { io: x, stdout, stderr } = io();
      const out = join(dir, "report.md");
      const code = await main(["validate", t.dir, "--out", out], x);
      expect(code).toBe(1);
      const printed = [...stdout, ...stderr].join("\n");
      expect(printed).toMatch(/^infra validate: FAIL \| droplet files 0 \| .* errors 2 /);
      for (const s of ["secret-host", "192.0.2.77", "other-secret-host"]) expect(printed).not.toContain(s);
      const detail = await readFile(out, "utf8");
      expect(detail).toContain("droplets/secret-host.example.com.yaml");
      expect(detail).toContain("allow.ip[0].ports[0]");
    } finally {
      await t.cleanup();
    }
  });

  it("puts internal errors in the detail file only", async () => {
    const { io: x, stdout, stderr } = io({
      modules: () => {
        throw new Error(`boom shop.example.com ${SECRETS.DO_TOKEN}`);
      },
    });
    const out = join(dir, "report.md");
    const code = await main(["check", EXAMPLE_DIR, "--out", out], x);
    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["infra check: internal error; details in the --out file"]);
    const detail = await readFile(out, "utf8");
    expect(detail).toContain("boom shop.example.com ***");
    expect(detail).not.toContain(SECRETS.DO_TOKEN);
  });

  it("returns 1 when a stage fails (real registry, no credentials)", async () => {
    const { io: x, stdout } = io({ modules: undefined, env: {} });
    delete x.modules;
    const code = await main(["check", EXAMPLE_DIR, "--out", join(dir, "r.md")], x);
    expect(code).toBe(1);
    expect(stdout[0]).toMatch(/failed stages \d+$/);
  });
});

describe("parseArgs", () => {
  it("parses commands and options", () => {
    expect(parseArgs(["check", "infra", "--out", "c.md", "--base", "base", "--commit", "abcdef1"])).toEqual({
      command: "check",
      infraDir: "infra",
      out: "c.md",
      base: "base",
      commit: "abcdef1",
    });
    expect(parseArgs(["apply", "infra"])).toEqual({ command: "apply", infraDir: "infra", out: "infra-report.md" });
    expect(parseArgs(["apply", "infra", "--base", "before"])).toEqual({ command: "apply", infraDir: "infra", out: "infra-report.md", base: "before" });
  });
  it.each([[[]], [["plan", "x"]], [["check"]], [["check", "a", "b"]], [["check", "a", "--nope", "1"]], [["check", "a", "--out"]], [["drift", "a", "--base", "b"]], [["check", "a", "--commit", "main"]]])(
    "rejects %j",
    (argv) => {
      expect(parseArgs(argv)).toHaveProperty("error");
    },
  );
});
