// Guards on the workflow files themselves: the gates that keep an accidental push to infra's
// main from writing anything must stay where they are.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}

async function steps(file: string): Promise<Step[]> {
  const path = fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url));
  const wf = parse(await readFile(path, "utf8")) as { jobs: Record<string, { steps: Step[] }> };
  return Object.values(wf.jobs)[0]!.steps;
}

const secretsOf = (s: Step) => Object.values(s.env ?? {}).filter((v) => v.includes("secrets."));

describe("apply.yml", () => {
  it("first refuses unless INFRA_APPLY_ENABLED is true, before any checkout or secret", async () => {
    const all = await steps("apply.yml");
    const gate = all[0]!;
    expect(gate.env).toEqual({ ENABLED: "${{ vars.INFRA_APPLY_ENABLED }}" });
    expect(gate.run).toContain('[ "$ENABLED" != "true" ]');
    expect(gate.run).toContain("exit 1");
    expect(gate.if).toBeUndefined();
  });

  it("checks that the commit is the head of infra's main before fetching and again right before applying", async () => {
    const all = await steps("apply.yml");
    const names = all.map((s) => s.name ?? s.uses);
    const heads = all.flatMap((s, i) => (s.run?.includes("infra-main-head.sh") ? [i] : []));
    expect(heads).toHaveLength(2);
    expect(heads[0]!).toBeLessThan(names.indexOf("Fetch the commit"));
    expect(heads[1]!).toBe(names.indexOf("Apply") - 1);
  });

  it("validates with only the Telegram token, and asks for the load alert", async () => {
    const v = (await steps("apply.yml")).find((s) => s.name?.startsWith("Validate ("))!;
    expect(secretsOf(v)).toEqual(["${{ secrets.TELEGRAM_BOT_TOKEN }}"]);
    expect(v.run).toContain("--notify apply");
    expect(v.env?.TELEGRAM_CHAT_ID).toBe("${{ vars.TELEGRAM_CHAT_ID }}");
  });
});

describe("drift.yml", () => {
  it("skips validate and drift when infra's main has no account.yaml", async () => {
    const all = await steps("drift.yml");
    const fetch = all.find((s) => s.name === "Fetch infra's main")!;
    expect(fetch.run).toContain('-f "$RUNNER_TEMP/infra-head/account.yaml"');
    expect(fetch.run).toContain("::notice::");
    for (const name of ["Drift"]) expect(all.find((s) => s.name === name)!.if).toBe("steps.head.outputs.ready == 'true'");
    const v = all.find((s) => s.name?.startsWith("Validate ("))!;
    expect(v.if).toBe("steps.head.outputs.ready == 'true'");
    expect(secretsOf(v)).toEqual(["${{ secrets.TELEGRAM_BOT_TOKEN }}"]);
    expect(v.run).toContain("--notify drift");
    expect(v.env?.TELEGRAM_CHAT_ID).toBe("${{ vars.TELEGRAM_CHAT_ID }}");
  });
});
