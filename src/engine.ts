// The engine: runs validate / check / apply / drift over the modules in the registry.
//
//   load -> offline checks -> observe droplets -> desired state -> checks against base (--base)
//        -> checks on desired
//        -> plan every module (observe + diff)
//   apply only: stop if anything failed or any error was found; apply droplets; if droplets
//        changed, re-observe them and re-plan the rest (new droplets now have IPs); apply each
//        module's changes in registry order.
//   apply and drift: always end with the Telegram summary (also when apply was blocked).
//
// Each stage is recorded in the report (ok / failed / not-implemented / skipped). Error text
// is redacted of secret values and only ever reaches the detail file.

import { buildDesired, type DesiredState } from "./core/desired.js";
import { hasErrors, NotImplementedError } from "./core/diagnostics.js";
import type { FetchFn } from "./core/http.js";
import { loadInfraDir } from "./core/loader.js";
import type { InfraConfig } from "./core/model.js";
import type { ObservedDroplet } from "./core/observed.js";
import { isChange, type ModulePlan, type PlanOp, type Provider, type RunContext, type RunMode } from "./core/plan.js";
import { newReport, reportPassed, type RunReport } from "./core/report.js";
import { Secrets } from "./core/secrets.js";
import { createModules, type Modules } from "./registry.js";

export interface EngineOptions {
  mode: RunMode | "validate";
  infraDir: string;
  /** check only: a checkout of the PR's base, for checkChange. */
  baseDir?: string;
  infraCommit?: string;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to the registry. */
  modules?: (ctx: RunContext) => Modules;
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

class Stages {
  constructor(
    private readonly report: RunReport,
    private readonly secrets: Secrets,
  ) {}

  /** Runs fn as a named stage. Returns undefined when it failed or isn't implemented yet. */
  async run<T>(stage: string, fn: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await fn();
      this.report.stages.push({ stage, status: "ok" });
      return { ok: true, value };
    } catch (e) {
      const status = e instanceof NotImplementedError ? "not-implemented" : "failed";
      this.report.stages.push({ stage, status, error: this.secrets.redact(errText(e)) });
      return { ok: false };
    }
  }

  skip(stage: string, reason: string) {
    this.report.stages.push({ stage, status: "skipped", error: reason });
  }
}

/** Ops for a frozen droplet become report ops: shown in the plan, never applied. */
export function freezeOps(plan: ModulePlan, frozen: ReadonlySet<string>): ModulePlan {
  if (!frozen.size) return plan;
  return {
    ...plan,
    ops: plan.ops.map((op) =>
      op.droplet && frozen.has(op.droplet) && op.action !== "report"
        ? { ...op, action: "report" as const, reason: `frozen droplet, would ${op.action}: ${op.reason}` }
        : op,
    ),
  };
}

interface Planned {
  provider: Provider<unknown>;
  observed?: unknown;
  plan?: ModulePlan;
}

export async function runEngine(opts: EngineOptions): Promise<RunReport> {
  const now = opts.now ?? (() => new Date());
  const secrets = new Secrets(opts.env);
  const report = newReport(opts.mode, now(), opts.infraCommit);
  const stages = new Stages(report, secrets);
  const finish = () => {
    report.finishedAt = now().toISOString();
    return report;
  };

  // 1. Load and validate the checkout.
  const loaded = await stages.run("load", () => loadInfraDir(opts.infraDir));
  if (!loaded.ok) return finish();
  report.diagnostics.push(...loaded.value.diagnostics);
  const config = loaded.value.config;
  if (!config) return finish();
  report.dropletFiles = config.droplets.length;
  if (opts.mode === "validate") return finish();
  const mode = opts.mode;

  const ctx: RunContext = {
    mode,
    account: config.account,
    secrets,
    fetch: opts.fetch,
    allowWrites: mode === "apply",
    now,
    sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const modules = (opts.modules ?? createModules)(ctx);

  // 2. Offline checks.
  const checked = await stages.run("checks", () => modules.checks.checkConfig(config));
  if (checked.ok) report.diagnostics.push(...checked.value);
  let base: InfraConfig | undefined;
  if (opts.baseDir) {
    const b = await stages.run("load base", () => loadInfraDir(opts.baseDir!));
    if (b.ok && b.value.config) base = b.value.config;
    else if (b.ok) stages.skip("checks against base", "the base checkout does not load");
  }

  // 3. Observe the droplets and build the desired state.
  const plans = async (): Promise<{ desired: DesiredState; droplets: Planned; others: Planned[] } | undefined> => {
    const obs = await stages.run("observe droplets", () => modules.droplets.observeDroplets());
    if (!obs.ok) return undefined;
    const desired = buildDesired(config, obs.value.droplets);
    const frozen = new Set(desired.droplets.filter((d) => d.frozen).map((d) => d.name));
    const droplets: Planned = { provider: modules.droplets, observed: obs.value };
    const dp = await stages.run("plan droplets", () => modules.droplets.diff(desired, obs.value));
    if (dp.ok) droplets.plan = freezeOps(dp.value, frozen);
    const others: Planned[] = [];
    for (const provider of modules.providers) {
      const p: Planned = { provider };
      const o = await stages.run(`observe ${provider.module}`, () => provider.observe(desired));
      if (o.ok) {
        p.observed = o.value;
        const d = await stages.run(`plan ${provider.module}`, () => provider.diff(desired, o.value));
        if (d.ok) p.plan = freezeOps(d.value, frozen);
      } else {
        stages.skip(`plan ${provider.module}`, "observe failed");
      }
      others.push(p);
    }
    return { desired, droplets, others };
  };

  const record = (desired: DesiredState, all: Planned[]) => {
    report.unmanaged = desired.unmanaged.map((d: ObservedDroplet) => ({ id: d.id, name: d.name, region: d.region }));
    report.plans = all.filter((p) => p.plan).map((p) => p.plan!);
    report.credentials = all.flatMap((p) => (p.provider.credentials && p.observed !== undefined ? p.provider.credentials(p.observed) : []));
  };

  // 4. Plan (all modes), then apply (apply mode only). Every apply outcome, and every drift run,
  //    ends in the Telegram summary: an apply has no PR to comment on, so a blocked or failed
  //    apply must still reach people.
  const planAndApply = async (): Promise<void> => {
    let state = await plans();
    // Against the base: needs the observed droplets (a removed file's droplet must be gone,
    // decision 15). Runs without them when they could not be read; checkChange then fails safe.
    if (base) {
      const b = base;
      const desired = state?.desired;
      const ch = await stages.run("checks against base", () => modules.checks.checkChange(b, config, desired));
      if (ch.ok) report.diagnostics.push(...ch.value);
    }
    if (!state) return;
    report.diagnostics.push(...state.desired.diagnostics);
    const desiredChecks = await stages.run("checks on desired state", () => modules.checks.checkDesired(state!.desired));
    if (desiredChecks.ok) report.diagnostics.push(...desiredChecks.value);
    record(state.desired, [state.droplets, ...state.others]);

    if (mode !== "apply") return;

    // Nothing is written unless the whole plan is clean.
    if (!reportPassed(report) || hasErrors(report.diagnostics)) {
      stages.skip("apply", "the plan has errors or failed stages; nothing applied");
      return;
    }

    const applyOne = async (p: Planned) => {
      if (!p.plan) {
        stages.skip(`apply ${p.provider.module}`, "no plan");
        return;
      }
      const ready = p.plan.ops.filter((op) => isChange(op) && !op.pending);
      const notReady: PlanOp[] = p.plan.ops.filter((op) => isChange(op) && op.pending);
      const res = await stages.run(`apply ${p.provider.module}`, () => p.provider.apply(ready, p.observed));
      if (res.ok) {
        res.value.skipped.push(...notReady.map((op) => ({ op, reason: "waiting for a droplet that isn't up yet" })));
        report.applied.push(res.value);
      }
    };

    const dropletChanges = state.droplets.plan?.ops.filter(isChange).length ?? 0;
    await applyOne(state.droplets);
    if (dropletChanges > 0) {
      // New droplets now have IPs, tags changed: plan everything again before applying the rest.
      const again = await plans();
      if (!again) {
        stages.skip("apply", "re-planning after droplet changes failed; nothing else applied");
        return;
      }
      state = again;
      record(state.desired, [state.droplets, ...state.others]);
    }
    for (const p of state.others) await applyOne(p);
  };
  await planAndApply();

  // 5. Telegram summary (apply and drift; check results go to the PR comment instead).
  if (mode !== "check") {
    if (config.account.telegram && secrets.has("TELEGRAM_BOT_TOKEN")) {
      await stages.run("notify telegram", async () => {
        await modules.notifier.sendTelegram(ctx, modules.notifier.renderTelegram(report));
      });
    } else {
      stages.skip("notify telegram", "no telegram chat in account.yaml or no TELEGRAM_BOT_TOKEN");
    }
  }
  return finish();
}
