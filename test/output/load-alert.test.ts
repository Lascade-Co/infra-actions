// The Telegram alert when apply or drift (or the validate guarding them) can't load the
// infra data. Fake names and ids only.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, parseArgs, type CliIO } from "../../src/cli.js";
import { runEngine, type EngineOptions } from "../../src/engine.js";
import { lenientChatId, renderLoadFailure } from "../../src/output/load-alert.js";
import { loadInfraDir, readInfraDir } from "../../src/core/loader.js";
import { EXAMPLE_DIR, tempDir } from "../helpers.js";

const TOKEN = "tg-secret-value-0007";
const CHAT = "-1000000000000";

interface Sent {
  url: string;
  body: { chat_id: string; text: string };
}

function recorder(status = 200) {
  const sent: Sent[] = [];
  const fetch: EngineOptions["fetch"] = async (url, init) => {
    sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status });
  };
  return { sent, fetch };
}

describe("load-failure alert", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    await cp(EXAMPLE_DIR, dir, { recursive: true });
  });
  afterEach(async () => {
    await cleanup();
  });

  const breakDroplet = () => writeFile(join(dir, "droplets", "shop.example.com.yaml"), "name: shop.example.com\nweb: {exposure: nope}\n");

  it.each(["apply", "drift"] as const)("%s posts counts and error codes only, no names", async (mode) => {
    await breakDroplet();
    const { sent, fetch } = recorder();
    const report = await runEngine({ mode, infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch, infraCommit: "0123abcdef" });
    expect(report.stages.map((s) => [s.stage, s.status])).toEqual([
      ["load", "ok"],
      ["notify telegram", "ok"],
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/sendMessage");
    expect(sent[0]!.body.chat_id).toBe(CHAT);
    const text = sent[0]!.body.text;
    expect(text).toContain(`infra ${mode}`);
    expect(text).toContain("0123abc");
    expect(text).toMatch(/\d+ errors? \(schema \d+/);
    expect(text).not.toMatch(/example\.(com|net)|droplets\//);
  });

  it("reads the chat id from an account.yaml that itself fails the schema", async () => {
    await writeFile(join(dir, "account.yaml"), `telegram:\n  chat_id: "${CHAT}"\nunknown_key: 1\n`);
    const { sent, fetch } = recorder();
    await runEngine({ mode: "apply", infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch });
    expect(sent.map((s) => s.body.chat_id)).toEqual([CHAT]);
  });

  it("falls back to TELEGRAM_CHAT_ID when account.yaml is missing, and skips without either", async () => {
    await rm(join(dir, "account.yaml"));
    expect(await lenientChatId(dir, {})).toBeUndefined();
    expect(await lenientChatId(dir, { TELEGRAM_CHAT_ID: "-42" })).toBe("-42");
    expect(await lenientChatId(dir, { TELEGRAM_CHAT_ID: "not-a-chat" })).toBeUndefined();
    const { sent, fetch } = recorder();
    const report = await runEngine({ mode: "drift", infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch });
    expect(sent).toEqual([]);
    expect(report.stages.at(-1)).toMatchObject({ stage: "notify telegram", status: "skipped" });
  });

  it("is skipped without the bot token", async () => {
    await breakDroplet();
    const { sent, fetch } = recorder();
    const report = await runEngine({ mode: "apply", infraDir: dir, env: {}, fetch });
    expect(sent).toEqual([]);
    expect(report.stages.at(-1)).toMatchObject({ stage: "notify telegram", status: "skipped" });
  });

  it("records a failed send without the token or any response text", async () => {
    await breakDroplet();
    const { fetch } = recorder(500);
    const report = await runEngine({ mode: "apply", infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch });
    const st = report.stages.at(-1)!;
    expect(st).toMatchObject({ stage: "notify telegram", status: "failed" });
    expect(st.error).toContain("HTTP 500");
    expect(st.error).not.toContain(TOKEN);
  });

  it("validate sends it only with --notify, and check never does", async () => {
    await breakDroplet();
    for (const [mode, notify, expected] of [
      ["validate", undefined, 0],
      ["validate", "apply", 1],
      ["check", undefined, 0],
    ] as const) {
      const { sent, fetch } = recorder();
      await runEngine({ mode, infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch, ...(notify ? { notifyLoadFailure: notify } : {}) });
      expect(sent, `${mode} ${notify}`).toHaveLength(expected);
    }
  });

  it("sends nothing when the data loads", async () => {
    const { sent, fetch } = recorder();
    const report = await runEngine({ mode: "validate", infraDir: dir, env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch, notifyLoadFailure: "apply" });
    expect(sent).toEqual([]);
    expect(report.stages).toEqual([{ stage: "load", status: "ok" }]);
  });

  it("renders the internal-error and drift wording", () => {
    expect(renderLoadFailure("drift", [], undefined, true)).toContain("internal error");
    expect(renderLoadFailure("drift", [])).toContain("No drift report today");
    expect(renderLoadFailure("apply", [{ level: "error", code: "layout", message: "x", file: "account.yaml" }])).toContain("1 error (layout 1)");
  });
});

describe("cli --notify", () => {
  it("is accepted only for validate, with apply or drift", () => {
    expect(parseArgs(["validate", "d", "--notify", "apply"])).toMatchObject({ notify: "apply" });
    expect(parseArgs(["validate", "d", "--notify", "check"])).toHaveProperty("error");
    expect(parseArgs(["check", "d", "--notify", "apply"])).toHaveProperty("error");
  });

  it("validate --notify posts the alert and prints one line with nothing sensitive", async () => {
    const t = await tempDir();
    try {
      await cp(EXAMPLE_DIR, t.dir, { recursive: true });
      await mkdir(join(t.dir, "droplets", "sub"));
      await writeFile(join(t.dir, "droplets", "sub", "x.example.com.yaml"), "name: x.example.com\nssh: [admins]\n");
      const { sent, fetch } = recorder();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: CliIO = { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l), env: { TELEGRAM_BOT_TOKEN: TOKEN }, fetch };
      const code = await main(["validate", t.dir, "--notify", "drift"], io);
      expect(code).toBe(1);
      expect(sent).toHaveLength(1);
      expect(stdout).toHaveLength(1);
      expect([...stdout, ...stderr].join("\n")).not.toMatch(/example\.|tg-secret|-1000000000000/);
    } finally {
      await t.cleanup();
    }
  });
});

describe("loader: account.yaml missing", () => {
  it("is reported exactly once", async () => {
    const t = await tempDir();
    try {
      await mkdir(join(t.dir, "droplets"));
      expect((await readInfraDir(t.dir)).diagnostics).toEqual([]);
      const res = await loadInfraDir(t.dir);
      expect(res.diagnostics.filter((d) => d.file === "account.yaml")).toEqual([expect.objectContaining({ message: "missing" })]);
      expect(res.diagnostics).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});
