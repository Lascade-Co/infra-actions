// Fake modules for engine and CLI tests: no network, deterministic, record every call.

import { KNOWN_AFTER_CREATE } from "../src/core/constants.js";
import type { DesiredState } from "../src/core/desired.js";
import type { Diagnostic } from "../src/core/diagnostics.js";
import type { ObservedDroplet } from "../src/core/observed.js";
import type { ApplyResult, ModuleName, ModulePlan, PlanOp, Provider, RunContext } from "../src/core/plan.js";
import type { DropletsProvider } from "../src/droplets/index.js";
import { applyFirewall } from "../src/firewall/index.js";
import type { Modules } from "../src/registry.js";
import { observedDroplet } from "./helpers.js";

export interface FakeOptions {
  droplets: ObservedDroplet[];
  checkErrors?: Diagnostic[];
  /** Modules whose observe throws this error. */
  failObserve?: Partial<Record<ModuleName, Error>>;
  /** Called with the token-bearing context, to prove it reaches modules. */
  onContext?: (ctx: RunContext) => void;
  /** Modules whose apply throws this error, or ("op") reports its first op as failed. */
  failApply?: Partial<Record<ModuleName, Error | "op">>;
  /** checkDesired's result, per call (1-based): lets a re-plan find an error the first plan didn't. */
  desiredDiagnostics?: (call: number) => Diagnostic[];
  /** Extra diagnostics in the cloudflare plan. */
  cloudflareDiagnostics?: Diagnostic[];
}

export interface FakeRun {
  calls: string[];
  contexts: RunContext[];
  telegram: string[][];
  modules: (ctx: RunContext) => Modules;
}

const applyAll = (module: ModuleName, ops: PlanOp[]): ApplyResult => ({ module, applied: ops, failed: [], skipped: [] });

export function fakeModules(opts: FakeOptions): FakeRun {
  const calls: string[] = [];
  const contexts: RunContext[] = [];
  const telegram: string[][] = [];
  let live = [...opts.droplets];
  let nextId = 500;

  const failIf = (m: ModuleName) => {
    const e = opts.failObserve?.[m];
    if (e) throw e;
  };
  /** applyAll, unless opts.failApply says this module fails. */
  const applied = (m: ModuleName, ops: PlanOp[]): ApplyResult => {
    const f = opts.failApply?.[m];
    if (f instanceof Error) throw f;
    if (f === "op" && ops.length) return { module: m, applied: [], failed: [{ op: ops[0]!, error: "HTTP 500" }], skipped: ops.slice(1).map((op) => ({ op, reason: "after a failure" })) };
    return applyAll(m, ops);
  };
  let desiredCalls = 0;

  const modules = (ctx: RunContext): Modules => {
    contexts.push(ctx);
    opts.onContext?.(ctx);
    const droplets: DropletsProvider = {
      module: "droplets",
      observeDroplets: async () => {
        calls.push("observe droplets");
        failIf("droplets");
        return { droplets: live.map((d) => ({ ...d })) };
      },
      observe: async () => ({ droplets: live }),
      diff: (desired: DesiredState): ModulePlan => {
        calls.push("plan droplets");
        const ops: PlanOp[] = desired.droplets
          .filter((d) => d.status === "create")
          .map((d) => ({
            provider: "digitalocean",
            module: "droplets",
            kind: "droplet",
            key: d.name,
            action: "create",
            before: null,
            after: { name: d.name, region: d.region ?? null },
            reason: `droplet file with profile ${d.spec.profile}`,
            droplet: d.name,
          }));
        return { module: "droplets", ops, unchanged: desired.droplets.length - ops.length, diagnostics: [] };
      },
      apply: async (ops) => {
        calls.push(`apply droplets ${ops.length}`);
        const res = applied("droplets", ops);
        for (const op of res.applied) live.push(observedDroplet(op.key, { id: nextId++, privateIpv4: `10.0.0.${nextId - 400}` }));
        return res;
      },
    };
    const cloudflare: Provider<{ n: number }> = {
      module: "cloudflare",
      observe: async () => {
        calls.push("observe cloudflare");
        failIf("cloudflare");
        return { n: 1 };
      },
      diff: (desired) => {
        calls.push("plan cloudflare");
        const ops: PlanOp[] = desired.droplets
          .filter((d) => d.sshHostname && (d.status === "exists" || d.status === "create"))
          .map((d) => ({
            provider: "cloudflare",
            module: "cloudflare",
            kind: "dns-record",
            key: `A ${d.vpcHostname}`,
            action: "create",
            before: null,
            after: { content: d.privateIpv4 ?? KNOWN_AFTER_CREATE },
            reason: "private name for a managed droplet",
            droplet: d.name,
            ...(d.privateIpv4 ? {} : { pending: true }),
          }));
        return { module: "cloudflare", ops, unchanged: 0, diagnostics: [...(opts.cloudflareDiagnostics ?? [])] };
      },
      apply: async (ops) => {
        calls.push(`apply cloudflare ${ops.length}`);
        return applied("cloudflare", ops);
      },
    };
    const firewall: Provider<{ n: number }> = {
      module: "firewall",
      observe: async () => ({ n: 0 }),
      diff: (desired) => ({
        module: "firewall",
        ops: desired.droplets
          .filter((d) => d.spec.allow.ip.length)
          .map((d) => ({
            provider: "digitalocean",
            module: "firewall",
            kind: "firewall-rule",
            key: `fw-${d.name}`,
            action: "report",
            before: null,
            after: { sources: d.spec.allow.ip.map((x) => x.from) },
            reason: "allow.ip (report-only until Phase 5)",
            droplet: d.name,
          })),
        unchanged: 0,
        diagnostics: [],
      }),
      apply: async (ops) => {
        calls.push(`apply firewall ${ops.length}`);
        return applyFirewall(ops);
      },
    };
    const sshconfig: Provider<{ sha: string }> = {
      module: "sshconfig",
      observe: async () => ({ sha: "abc" }),
      diff: () => ({ module: "sshconfig", ops: [], unchanged: 1, diagnostics: [] }),
      apply: async (ops) => {
        calls.push(`apply sshconfig ${ops.length}`);
        return applied("sshconfig", ops);
      },
      credentials: () => [{ name: "INFRA_GH_TOKEN", expiresAt: "2027-01-01" }],
    };
    return {
      droplets,
      providers: [cloudflare, firewall, sshconfig] as Array<Provider<unknown>>,
      checks: {
        checkConfig: () => {
          calls.push("checks");
          return opts.checkErrors ?? [];
        },
        checkDesired: () => opts.desiredDiagnostics?.(++desiredCalls) ?? [],
        checkChange: () => [],
      },
      notifier: {
        renderTelegram: () => ["summary"],
        sendTelegram: async (_ctx, messages) => {
          telegram.push(messages);
        },
      },
    };
  };
  return { calls, contexts, telegram, modules };
}
