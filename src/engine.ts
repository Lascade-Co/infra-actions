// The engine: runs validate / check / apply / drift over the modules in the registry.
//
//   load -> offline checks -> observe droplets -> desired state -> checks against base (--base)
//        -> checks on desired
//        -> plan every module (observe + diff)
//   apply only (all-or-nothing, decision 16): stop before writing anything if any stage failed
//        or any error was found (checks, plan diagnostics); apply droplets; if droplets changed,
//        re-observe them and re-plan the rest (new droplets now have IPs), stopping if that plan
//        has errors; apply each module's changes in registry order. The first module that fails
//        stops the run: the modules after it are skipped and reported as skipped.
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
import { lenientChatId, renderLoadFailure, sendLoadFailure } from "./output/load-alert.js";

export interface EngineOptions {
  mode: RunMode | "validate";
  infraDir: string;
  /**
   * check and apply: a checkout to compare against, for checkChange. check gets the PR's base;
   * apply gets the commit main was at before the push (so a removed file whose droplet still
   * exists stops the apply too, decision 15, even when a PR was merged with a failed check).
   */
  baseDir?: string;
  infraCommit?: string;
  env: Record<string, string | undefined>;
  fetch: FetchFn;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to the registry. */
  modules?: (ctx: RunContext) => Modules;
  /**
   * validate only: the run this validation guards (the workflows validate without the API
   * tokens first). When the checkout doesn't load, send the load-failure alert to Telegram as
   * that run would. apply and drift send it themselves.
   */
  notifyLoadFailure?: "apply" | "drift";
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

/** Reason prefix of a frozen droplet's SSH access change, which is applied (the PR comment shows it). */
export const FROZEN_SSH_REASON = "frozen: only SSH access changes are applied";

/** A frozen droplet's SSH access change: a cloudflare update of its target's tag or its ssh- app's include list. */
export const isFrozenSshChange = (op: PlanOp): boolean =>
  op.appliesWhenFrozen === true && op.provider === "cloudflare" && op.action === "update" && (op.kind === "infra-target" || op.kind === "access-app");

/**
 * Ops for a frozen droplet become report ops: shown in the plan, never applied. The one exception
 * is its SSH access (isFrozenSshChange): applied, with the reason saying so.
 */
export function freezeOps(plan: ModulePlan, frozen: ReadonlySet<string>): ModulePlan {
  if (!frozen.size) return plan;
  return {
    ...plan,
    ops: plan.ops.map((op) => {
      if (!op.droplet || !frozen.has(op.droplet) || op.action === "report") return op;
      if (isFrozenSshChange(op)) return { ...op, reason: `${FROZEN_SSH_REASON}: ${op.reason}` };
      return { ...op, action: "report" as const, reason: `frozen droplet, would ${op.action}: ${op.reason}` };
    }),
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

  // 1. Load and validate the checkout. An apply or drift run that can't load it (or a validate
  //    that guards one) says so on Telegram: counts and error codes only, no names.
  const alertRun = opts.mode === "apply" || opts.mode === "drift" ? opts.mode : opts.notifyLoadFailure;
  const loadFailed = async (internalError: boolean) => {
    if (!alertRun) return finish();
    const text = renderLoadFailure(alertRun, report.diagnostics, opts.infraCommit, internalError);
    const chatId = await lenientChatId(opts.infraDir, opts.env);
    if (!chatId || !secrets.has("TELEGRAM_BOT_TOKEN")) {
      stages.skip("notify telegram", "no telegram chat id or no TELEGRAM_BOT_TOKEN");
      return finish();
    }
    await stages.run("notify telegram", () => sendLoadFailure({ fetch: opts.fetch, secrets, chatId, text }));
    return finish();
  };
  const loaded = await stages.run("load", () => loadInfraDir(opts.infraDir));
  if (!loaded.ok) return loadFailed(true);
  report.diagnostics.push(...loaded.value.diagnostics);
  const config = loaded.value.config;
  if (!config) return loadFailed(false);
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
    if (!state) {
      if (mode === "apply") stages.skip("apply", "the droplets could not be read; nothing applied");
      return;
    }
    report.diagnostics.push(...state.desired.diagnostics);
    const desiredChecks = await stages.run("checks on desired state", () => modules.checks.checkDesired(state!.desired));
    if (desiredChecks.ok) report.diagnostics.push(...desiredChecks.value);
    record(state.desired, [state.droplets, ...state.others]);

    if (mode !== "apply") return;

    // All-or-nothing (decision 16), part 1: nothing is written unless the whole run is clean
    // first: the checkout loads, every check ran without an error (checkConfig, checkDesired,
    // and checkChange when --base is given) and every module observed and planned without an
    // error. The PR check runs the same code, but merging is not blocked by a failed check.
    if (!reportPassed(report) || hasErrors(report.diagnostics)) {
      stages.skip("apply", "the plan has errors or failed stages; nothing applied");
      return;
    }

    /** Applies one module's ready ops. false when the module failed (threw, or an op failed). */
    const applyOne = async (p: Planned): Promise<boolean> => {
      if (!p.plan) {
        stages.skip(`apply ${p.provider.module}`, "no plan");
        return true;
      }
      const ready = p.plan.ops.filter((op) => isChange(op) && !op.pending);
      const notReady: PlanOp[] = p.plan.ops.filter((op) => isChange(op) && op.pending);
      const res = await stages.run(`apply ${p.provider.module}`, () => p.provider.apply(ready, p.observed));
      if (!res.ok) return false;
      res.value.skipped.push(...notReady.map((op) => ({ op, reason: "waiting for a droplet that isn't up yet" })));
      report.applied.push(res.value);
      return res.value.failed.length === 0;
    };

    // All-or-nothing, part 2: the first module that fails stops the run. The modules after it
    // are not applied and are reported as skipped (stage "apply" says why).
    const stop = (rest: Planned[], reason: string) => {
      stages.skip("apply", reason);
      for (const p of rest) stages.skip(`apply ${p.provider.module}`, reason);
    };

    const dropletChanges = state.droplets.plan?.ops.filter(isChange).length ?? 0;
    if (!(await applyOne(state.droplets))) {
      stop(state.others, "applying droplets failed; nothing after it was applied");
      return;
    }
    if (dropletChanges > 0) {
      // New droplets now have IPs, tags changed: plan everything again before applying the rest,
      // and hold the new plan to the same rule as the first one.
      const firstStage = report.stages.length;
      const again = await plans();
      if (!again) {
        stop(state.others, "re-planning after droplet changes failed; nothing else applied");
        return;
      }
      const seen = new Set(report.diagnostics.map((d) => JSON.stringify(d)));
      const fresh = [...again.desired.diagnostics];
      const rechecked = await stages.run("checks on desired state", () => modules.checks.checkDesired(again.desired));
      if (rechecked.ok) fresh.push(...rechecked.value);
      report.diagnostics.push(...fresh.filter((d) => !seen.has(JSON.stringify(d))));
      state = again;
      const all = [state.droplets, ...state.others];
      record(state.desired, all);
      const broken = report.stages.slice(firstStage).some((st) => st.status === "failed" || st.status === "not-implemented");
      if (broken || hasErrors(fresh) || hasErrors(all.flatMap((p) => p.plan?.diagnostics ?? []))) {
        stop(state.others, "the plan made again after the droplet changes has errors or failed stages; nothing else applied");
        return;
      }
    }
    for (const [i, p] of state.others.entries()) {
      if (!(await applyOne(p))) {
        stop(state.others.slice(i + 1), `applying ${p.provider.module} failed; nothing after it was applied`);
        return;
      }
    }
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
