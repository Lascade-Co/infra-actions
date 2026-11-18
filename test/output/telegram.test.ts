import { describe, expect, it } from "vitest";
import { loadInfraFiles } from "../../src/core/loader.js";
import type { PlanOp, RunContext } from "../../src/core/plan.js";
import { MissingSecretError, Secrets } from "../../src/core/secrets.js";
import { MESSAGE_MAX, packMessages, renderTelegram, sendTelegram, stripHtml } from "../../src/output/index.js";
import { exampleFiles } from "../helpers.js";
import { applyReport, checkReport, cleanReport, driftReport, op } from "./fixtures.js";

const TOKEN = "tg-secret-value-0007";

/** Every tag opened in a message is closed in it. */
function expectBalanced(msg: string) {
  for (const tag of ["b", "i", "code", "blockquote"]) {
    const open = (msg.match(new RegExp(`<${tag}(?: [^>]*)?>`, "g")) ?? []).length;
    const close = (msg.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
    expect(open, `${tag} in ${msg.slice(0, 80)}`).toBe(close);
  }
}

describe("renderTelegram", () => {
  it("starts with a status line, then the time and the counts", () => {
    const [msg] = renderTelegram(applyReport());
    const lines = msg!.split("\n");
    expect(lines[0]).toBe("❌ <b>infra apply</b> · <code>0123456</code>");
    expect(lines[1]).toBe("🕒 19 Nov 2026, 09:30 IST");
    expect(lines[3]).toBe("⚠️ 1 warning   ➕ 2 created   ✏️ 3 updated   💥 1 failed   ⏭ 1 skipped   📋 3 report-only");
    expect(msg).toContain("❌ <b>Errors</b> (1)\n<blockquote>• <b>access-app</b> gone.example.com: cloudflare DELETE /accounts/x/access/apps/y: HTTP 500</blockquote>");
    expect(msg).toContain("➕ <b>Created</b>: Tunnel routes (1)\n<blockquote expandable>shop.example.com (tunnel 00000000)</blockquote>");
    expect(msg).toContain("✏️ <b>Updated</b>: ssh config (1)\n<blockquote expandable>ssh config (4 hosts)</blockquote>");
    expect(msg).not.toContain("SECRET-CONFIG-TEXT");
  });

  it.each([
    ["a clean apply that changed things", () => applyReport({ diagnostics: [], applied: applyReport().applied.map((a) => ({ ...a, failed: [] })) }), "✅"],
    ["an apply that changed things, with warnings", () => applyReport({ applied: applyReport().applied.map((a) => ({ ...a, failed: [] })) }), "⚠️"],
    ["an apply with nothing to change", () => cleanReport("apply"), "ℹ️"],
    ["a drift run that found drift", () => driftReport(), "⚠️"],
    ["a drift run with no drift", () => cleanReport("drift"), "✅"],
  ])("status for %s", (_, make, icon) => {
    expect(renderTelegram(make())[0]!.startsWith(`${icon} <b>`)).toBe(true);
  });

  it("says when apply was blocked and lists what was not applied", () => {
    const r = checkReport({ mode: "apply" });
    r.diagnostics.push({ level: "error", code: "x", message: "bad <thing> & more" });
    r.stages.push({ stage: "apply", status: "skipped", error: "the plan has errors or failed stages; nothing applied" });
    const [msg] = renderTelegram(r);
    expect(msg!.startsWith("❌ <b>infra apply</b>")).toBe(true);
    expect(msg).toContain("🛑 <b>Nothing applied</b>: the plan has errors or failed stages; nothing applied");
    expect(msg).toContain("⏸ 7 not applied");
    expect(msg).toContain("• error: bad &lt;thing&gt; &amp; more");
    expect(msg).toContain("⏸ <b>Not applied</b>: DNS records (2)");
  });

  it("drift: hand-made changes, droplets with no file and the token warning, short", () => {
    const msgs = renderTelegram(driftReport());
    expect(msgs).toHaveLength(1);
    const msg = msgs[0]!;
    expect(msg).toContain("⚠️ 1 warning   ✏️ 7 hand-made changes   📦 1 droplet with no file   📋 3 report-only");
    expect(msg).toContain("• 🔑 INFRA_GH_TOKEN expires on 2026-12-01 (in 12 days): renew it");
    expect(msg).toContain("✏️ <b>Hand-made changes</b> (7)\n<blockquote expandable>");
    expect(msg).toContain("• update dns-record A vpc-shop.example.com");
    expect(msg).toContain("📦 <b>Droplets with no file</b> (1)\n<blockquote expandable>• build-box (nyc1)</blockquote>");
    expect(msg).not.toContain("fw-db"); // report-only diffs are counted, not listed
  });

  it("drift with nothing to report says so", () => {
    expect(renderTelegram(cleanReport("drift"))[0]).toContain("No drift: the live accounts match the droplet files.");
  });

  it("splits long reports into messages under the limit, without breaking tags", () => {
    const r = applyReport();
    const many: PlanOp[] = Array.from({ length: 800 }, (_, i) => op({ kind: "dns-record", key: `A vpc-host-number-${i}.example.com`, droplet: `host-number-${i}.example.com` }));
    r.applied[1]!.applied.push(...many);
    const msgs = renderTelegram(r);
    expect(msgs.length).toBeGreaterThan(3);
    for (const m of msgs) {
      expect(m.length).toBeLessThanOrEqual(MESSAGE_MAX);
      expectBalanced(m);
    }
    expect(msgs.join("\n")).toContain("➕ <b>Created</b>: DNS records (800) (continued)");
  });

  it("uses the report's time, not the clock", () => {
    expect(renderTelegram(driftReport())).toEqual(renderTelegram(driftReport()));
  });
});

describe("packMessages / stripHtml", () => {
  it("packs whole blocks", () => {
    expect(packMessages(["a".repeat(10), "b".repeat(10), "c".repeat(10)], 25)).toEqual(["a".repeat(10) + "\n\n" + "b".repeat(10), "c".repeat(10)]);
  });
  it("strips tags and undoes escaping", () => {
    expect(stripHtml("<b>x</b> &lt;y&gt; &amp;")).toBe("x <y> &");
  });
});

describe("sendTelegram", () => {
  interface Sent {
    url: string;
    body: Record<string, unknown>;
  }
  async function ctx(fetch: RunContext["fetch"], env: Record<string, string> = { TELEGRAM_BOT_TOKEN: TOKEN }): Promise<RunContext> {
    const config = loadInfraFiles(await exampleFiles()).config!;
    return { mode: "apply", account: config.account, secrets: new Secrets(env), fetch, allowWrites: true, now: () => new Date(0), sleep: async () => {} };
  }
  function recorder(statuses: number[] = []) {
    const sent: Sent[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: statuses.shift() ?? 200 });
    };
    return { sent, fetch };
  }

  it("posts each message as HTML to the chat, numbered when there are several", async () => {
    const { sent, fetch } = recorder();
    await sendTelegram(await ctx(fetch), ["<b>one</b>", "two"]);
    expect(sent).toEqual([
      { url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { disable_web_page_preview: true, chat_id: "-1000000000000", text: "(1/2) <b>one</b>", parse_mode: "HTML" } },
      { url: `https://api.telegram.org/bot${TOKEN}/sendMessage`, body: { disable_web_page_preview: true, chat_id: "-1000000000000", text: "(2/2) two", parse_mode: "HTML" } },
    ]);
  });

  it("re-sends as plain text when Telegram rejects the HTML", async () => {
    const { sent, fetch } = recorder([400, 200]);
    await sendTelegram(await ctx(fetch), ["<b>x</b> &amp;"]);
    expect(sent[1]!.body).toEqual({ disable_web_page_preview: true, chat_id: "-1000000000000", text: "x &" });
  });

  it("throws on an HTTP error, naming the status and part but not the token", async () => {
    const { fetch } = recorder([500]);
    const err = await sendTelegram(await ctx(fetch), ["x"]).catch((e: Error) => e);
    expect(String(err)).toBe("Error: telegram sendMessage failed with HTTP 500 (part 1/1)");
  });

  it("never passes on a fetch error, which may carry the URL with the token", async () => {
    const fetch = async (url: string) => {
      throw new TypeError(`fetch failed for ${url}`);
    };
    const err = await sendTelegram(await ctx(fetch), ["x"]).catch((e: Error) => e);
    expect(String(err)).toBe("Error: telegram sendMessage failed: network error (part 1/1)");
    expect(String(err)).not.toContain(TOKEN);
  });

  it("needs the token and a chat id", async () => {
    const { fetch, sent } = recorder();
    await expect(sendTelegram(await ctx(fetch, {}), ["x"])).rejects.toBeInstanceOf(MissingSecretError);
    const c = await ctx(fetch);
    delete (c.account as { telegram?: unknown }).telegram;
    await expect(sendTelegram(c, ["x"])).rejects.toThrow("no telegram.chat_id");
    expect(sent).toEqual([]);
  });
});
