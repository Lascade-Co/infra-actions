// B5: OneUptime monitors from droplet files. See README.md in this folder.
//
// Endpoints, headers and the wire format live in ./api.ts; this file decides what to do.

import { randomUUID } from "node:crypto";
import { DNS_COMMENT_MARKER, HEALTH_BYPASS_PATH } from "../core/constants.js";
import type { DesiredDroplet, DesiredMonitor, DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import { ApiError } from "../core/http.js";
import type { ApplyResult, Json, ModulePlan, OpFailure, PlanOp, Provider, RunContext } from "../core/plan.js";
import { normPath } from "../core/values.js";
import {
  CRITERION,
  type CriterionRole,
  listAll,
  MONITOR_SELECT,
  MONITOR_TYPE,
  monitorData,
  monitorView,
  type MonitorStatusRef,
  type MonitorView,
  type MonitorWant,
  type Names,
  oneUptimeClient,
  type PartIds,
  partIds,
  PATHS,
  POLICY_SELECT,
  type ProjectIds,
  readSeverity,
  readStatus,
  rowId,
  SEVERITY_SELECT,
  type SeverityRef,
  STATUS_SELECT,
} from "./api.js";

/** A monitor as B5 reads it from OneUptime (fields it compares). */
export interface OneUptimeMonitor {
  id: string;
  name: string;
  description?: string;
  /** e.g. https://app.example.com/healthcheck/ */
  url?: string;
  /** "<hostname><path>": from the description after the marker, else the name. */
  key: string;
  /** OneUptime monitor type, e.g. Website. */
  type: string;
  /** Raw API object, for fields B5 compares but this skeleton doesn't name. */
  raw: unknown;
}

export interface OneUptimeObserved {
  /** Monitors the tool owns (marker DNS_COMMENT_MARKER in their description). */
  owned: OneUptimeMonitor[];
  /** Number of monitors the tool does not own (never touched, counted for the drift report). */
  foreignCount: number;
  /** The project's monitor statuses and incident severities (criteria refer to them by id). */
  statuses: MonitorStatusRef[];
  severities: SeverityRef[];
  /** Ids of the project's on-call policies; undefined when not read (none configured, or no permission). */
  onCallPolicyIds?: string[];
  /** Why the on-call policies could not be read (API error text, no secrets). */
  onCallPolicyReadError?: string;
}

const MODULE = "oneuptime" as const;

// ---------- ownership ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The marker as the description's first word ("managed-by:infra-sync2" is not ours). */
const OWNED_RE = new RegExp(`^${escapeRe(DNS_COMMENT_MARKER)}(?:\\s+(\\S+))?(?:\\s|$)`);

/** A key: "<hostname><path>", e.g. app.example.com/healthcheck/. */
const KEY_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/;

/**
 * The monitor's key when the tool owns it, else undefined: the word after the marker when it
 * looks like a key (so a renamed monitor keeps its identity), else the monitor's name.
 */
export function ownedKey(description: string | undefined, name: string): string | undefined {
  const m = OWNED_RE.exec(description ?? "");
  if (!m) return undefined;
  return m[1] && KEY_RE.test(m[1]) ? m[1] : name;
}

export const monitorKey = (m: Pick<DesiredMonitor, "hostname" | "path">): string => `${m.hostname}${m.path}`;

export function monitorDescription(key: string, source: string): string {
  return `${DNS_COMMENT_MARKER} ${key} (${source}; edits made here are overwritten)`;
}

// ---------- observe ----------

/**
 * Read-only: list the project's monitors, monitor statuses and incident severities (and the
 * on-call policies when account.yaml names some). Requests go through Access with the service
 * token (ONEUP_ACCESS_CLIENT_ID / ONEUP_ACCESS_CLIENT_SECRET headers) plus ONEUPTIME_API_KEY.
 */
export async function observeMonitors(ctx: RunContext): Promise<OneUptimeObserved> {
  const cfg = ctx.account.oneuptime;
  if (!cfg) return { owned: [], foreignCount: 0, statuses: [], severities: [] };
  const client = oneUptimeClient({ url: cfg.url, projectId: cfg.project_id, secrets: ctx.secrets, fetch: ctx.fetch, allowWrites: ctx.allowWrites });

  const owned: OneUptimeMonitor[] = [];
  let foreignCount = 0;
  for (const row of await listAll(client, PATHS.monitorList, MONITOR_SELECT)) {
    const id = rowId(row);
    const name = typeof row["name"] === "string" ? row["name"] : "";
    const description = typeof row["description"] === "string" ? row["description"] : undefined;
    const key = id ? ownedKey(description, name) : undefined;
    if (!id || key === undefined) {
      foreignCount++;
      continue;
    }
    const view = monitorView(row, { statuses: new Map(), severities: new Map() });
    owned.push({
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      ...(view.url ? { url: view.url } : {}),
      key,
      type: view.type,
      raw: row,
    });
  }

  const statuses = (await listAll(client, PATHS.monitorStatusList, STATUS_SELECT)).map(readStatus).filter((s): s is MonitorStatusRef => !!s);
  const severities = (await listAll(client, PATHS.incidentSeverityList, SEVERITY_SELECT)).map(readSeverity).filter((s): s is SeverityRef => !!s);

  const observed: OneUptimeObserved = { owned, foreignCount, statuses, severities };
  if (cfg.on_call_policy_ids?.length) {
    // Only to check account.yaml's ids; the key may not be allowed to read policies.
    try {
      observed.onCallPolicyIds = (await listAll(client, PATHS.onCallPolicyList, POLICY_SELECT)).map(rowId).filter((x): x is string => !!x);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      observed.onCallPolicyReadError = e.message;
    }
  }
  return observed;
}

// ---------- plan ----------

/** The statuses and severity every monitor's criteria use: operational, offline, most severe. */
export function projectIds(observed: OneUptimeObserved): { ids?: ProjectIds; missing: string[] } {
  const byPriority = (a: MonitorStatusRef, b: MonitorStatusRef) => a.priority - b.priority || a.id.localeCompare(b.id);
  const operational = observed.statuses.filter((s) => s.operational).sort(byPriority)[0];
  const offline = observed.statuses.filter((s) => s.offline).sort(byPriority)[0];
  const severity = [...observed.severities].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
  const missing = [
    ...(operational ? [] : ["a monitor status marked operational"]),
    ...(offline ? [] : ["a monitor status marked offline"]),
    ...(severity ? [] : ["an incident severity"]),
  ];
  if (!operational || !offline || !severity) return { missing };
  return { ids: { operationalStatusId: operational.id, offlineStatusId: offline.id, incidentSeverityId: severity.id }, missing };
}

const namesOf = (observed: OneUptimeObserved): Names => ({
  statuses: new Map(observed.statuses.map((s) => [s.id, s.name])),
  severities: new Map(observed.severities.map((s) => [s.id, s.name])),
});

/**
 * Why a monitor can't tell the app is down, as the Worker's healthWeak flag: through Access, a
 * staff site answers 302 to the login whatever its origin does, unless the path is bypassed (the
 * deploy target's /healthcheck on the droplet name, or an exception open to everyone). A public
 * site's protected paths need the login too (and are the tunnel's 404 on extra hostnames).
 */
export function weakHealthReason(d: DesiredDroplet, m: DesiredMonitor): string | undefined {
  const web = d.web;
  if (!web || !web.hostnames.includes(m.hostname)) return undefined;
  const hp = normPath(m.path);
  const under = (p: string) => hp === normPath(p) || hp.startsWith(normPath(p) + "/");
  if (web.exposure === "staff") {
    const bypassed =
      (d.deploy && m.hostname === d.name && under(`/${HEALTH_BYPASS_PATH}`)) || web.exceptions.some((e) => e.allow === "everyone" && under(e.path));
    if (bypassed) return undefined;
    return `${m.hostname} is a staff site and ${m.path} is not bypassed: the monitor only sees the staff login (302), so it stays up while the app is down`;
  }
  if (web.protectedPaths.some(under)) {
    return `${m.path} is under a protected path of ${m.hostname}: the monitor only sees the staff login (302), or the tunnel's 404 on an extra hostname`;
  }
  return undefined;
}

const viewJson = (v: MonitorView): Json => v as unknown as Json;

function changedFields(before: MonitorView, after: MonitorView): string[] {
  return (Object.keys(after) as Array<keyof MonitorView>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

function idsFor(project: ProjectIds, monitorId?: string, parts?: PartIds): Record<string, string> {
  const ids: Record<string, string> = { ...project };
  if (monitorId) ids["monitorId"] = monitorId;
  if (parts?.step) ids["stepId"] = parts.step;
  if (parts?.incident) ids["incidentId"] = parts.incident;
  for (const [role, id] of Object.entries(parts?.criteria ?? {})) if (id) ids[`criterion.${role}`] = id;
  return ids;
}

/**
 * Pure: one HTTP monitor per DesiredDroplet.monitors entry (key "<hostname><path>"), alerting
 * through account.oneuptime.on_call_policy_ids. Create and update owned monitors only; an owned
 * monitor no longer in any file is a `report` op (delete by hand). Foreign monitors never appear.
 */
export function planMonitors(desired: DesiredState, observed: OneUptimeObserved): ModulePlan {
  const cfg = desired.account.oneuptime;
  const diagnostics: Diagnostic[] = [];
  if (!cfg) {
    return {
      module: MODULE,
      ops: [],
      unchanged: 0,
      diagnostics: [{ level: "info", code: "oneuptime-not-configured", message: "account.yaml has no oneuptime section: no monitors are planned" }],
    };
  }
  const onCallPolicyIds = [...new Set(cfg.on_call_policy_ids ?? [])].sort();
  if (observed.onCallPolicyIds) {
    for (const id of onCallPolicyIds.filter((x) => !observed.onCallPolicyIds!.includes(x))) {
      diagnostics.push({ level: "error", code: "oneuptime-on-call-policy", message: `on-call policy ${id} (account.yaml oneuptime.on_call_policy_ids) does not exist in the OneUptime project` });
    }
  } else if (observed.onCallPolicyReadError) {
    diagnostics.push({
      level: "warning",
      code: "oneuptime-on-call-policy",
      message: `could not read OneUptime's on-call policies to check account.yaml's ids (${observed.onCallPolicyReadError})`,
    });
  }

  // What the files want, by key.
  const wants = new Map<string, { want: MonitorWant; droplet: DesiredDroplet }>();
  for (const d of desired.droplets) {
    for (const m of d.monitors) {
      const key = monitorKey(m);
      const prev = wants.get(key);
      if (prev) {
        diagnostics.push({
          level: "error",
          code: "duplicate-monitor",
          file: d.source,
          droplet: d.name,
          message: `monitor ${key} is also declared by ${prev.droplet.source}; each monitor may be declared once`,
        });
        continue;
      }
      const weak = weakHealthReason(d, m);
      if (weak) diagnostics.push({ level: "warning", code: "monitor-health-weak", file: d.source, droplet: d.name, message: weak });
      wants.set(key, {
        droplet: d,
        want: { name: key, description: monitorDescription(key, d.source), url: `https://${key}`, acceptApp404: m.acceptApp404, onCallPolicyIds },
      });
    }
  }

  // Owned monitors by key; extra ones with the same key are duplicates.
  const byKey = new Map<string, OneUptimeMonitor[]>();
  for (const m of [...observed.owned].sort((a, b) => a.id.localeCompare(b.id))) byKey.set(m.key, [...(byKey.get(m.key) ?? []), m]);

  const names = namesOf(observed);
  const project = projectIds(observed);
  if (!project.ids && wants.size) {
    diagnostics.push({
      level: "error",
      code: "oneuptime-project",
      message: `the OneUptime project has no ${project.missing.join(", no ")}; monitors can't be created or updated until it does`,
    });
  }

  const ops: PlanOp[] = [];
  const reports: PlanOp[] = [];
  let unchanged = 0;
  const report = (m: OneUptimeMonitor, reason: string, droplet?: string) =>
    reports.push({
      provider: MODULE,
      module: MODULE,
      kind: "monitor",
      key: m.key,
      action: "report",
      before: viewJson(monitorView(m.raw as Record<string, unknown>, names)),
      after: null,
      reason,
      ...(droplet ? { droplet } : {}),
      ids: { monitorId: m.id },
    });

  for (const key of [...wants.keys()].sort()) {
    const { want, droplet } = wants.get(key)!;
    const found = byKey.get(key) ?? [];
    const current = found.shift();
    if (!project.ids) continue; // error diagnostic above
    if (current && current.type !== MONITOR_TYPE) {
      report(
        current,
        `monitor type is ${current.type || "unknown"}, not ${MONITOR_TYPE}, and OneUptime can't change a monitor's type: delete it by hand and the next apply creates it`,
        droplet.name,
      );
      continue;
    }
    // Ids of parts don't show in the view, so placeholders do here.
    const after = monitorView(monitorData(want, project.ids, {}, () => "", true), names);
    if (!current) {
      ops.push({
        provider: MODULE,
        module: MODULE,
        kind: "monitor",
        key,
        action: "create",
        before: null,
        after: viewJson(after),
        reason: `${droplet.source} declares a monitor for ${want.url}`,
        droplet: droplet.name,
        ids: idsFor(project.ids),
      });
      continue;
    }
    const before = monitorView(current.raw as Record<string, unknown>, names);
    const diff = changedFields(before, after);
    if (!diff.length) {
      unchanged++;
      continue;
    }
    ops.push({
      provider: MODULE,
      module: MODULE,
      kind: "monitor",
      key,
      action: "update",
      before: viewJson(before),
      after: viewJson(after),
      reason: `${diff.join(", ")} differ${diff.length === 1 ? "s" : ""} from ${droplet.source}`,
      droplet: droplet.name,
      ids: idsFor(project.ids, current.id, partIds(current.raw as Record<string, unknown>)),
    });
  }

  for (const [key, left] of byKey) {
    const wanted = wants.get(key);
    // The first of a wanted key was taken above (shift); what is left is duplicates or unwanted.
    for (const m of left) {
      report(
        m,
        wanted
          ? `another owned monitor already checks ${key}; delete this duplicate by hand in OneUptime`
          : `no droplet file declares ${key} any more; delete it by hand in OneUptime (the tool never deletes monitors)`,
        wanted?.droplet.name,
      );
    }
  }

  reports.sort((a, b) => a.key.localeCompare(b.key) || String(a.ids?.["monitorId"]).localeCompare(String(b.ids?.["monitorId"])));
  return { module: MODULE, ops: [...ops, ...reports], unchanged, diagnostics };
}

// ---------- apply ----------

function wantFromView(v: Json | null): MonitorWant {
  const o = (v ?? {}) as Record<string, Json>;
  const policies = o["onCallPolicyIds"];
  if (typeof o["name"] !== "string" || typeof o["description"] !== "string" || typeof o["url"] !== "string" || typeof o["acceptApp404"] !== "boolean" || !Array.isArray(policies)) {
    throw new Error("monitor op has no usable `after`");
  }
  return { name: o["name"], description: o["description"], url: o["url"], acceptApp404: o["acceptApp404"], onCallPolicyIds: policies.map(String) };
}

function opParts(ids: Record<string, string>): { project: ProjectIds; parts: PartIds } {
  const need = (k: string) => {
    const v = ids[k];
    if (!v) throw new Error(`monitor op is missing ids.${k}`);
    return v;
  };
  const criteria: Partial<Record<CriterionRole, string>> = {};
  for (const role of Object.keys(CRITERION) as CriterionRole[]) if (ids[`criterion.${role}`]) criteria[role] = ids[`criterion.${role}`]!;
  return {
    project: { operationalStatusId: need("operationalStatusId"), offlineStatusId: need("offlineStatusId"), incidentSeverityId: need("incidentSeverityId") },
    parts: { ...(ids["stepId"] ? { step: ids["stepId"] } : {}), ...(ids["incidentId"] ? { incident: ids["incidentId"] } : {}), criteria },
  };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Creates and updates monitors through the API, in plan order; never deletes. Stops at the first
 * failure: the ops after it are skipped. `report` ops are skipped.
 */
export async function applyMonitors(ctx: RunContext, ops: PlanOp[], newId: () => string = randomUUID): Promise<ApplyResult> {
  const result: ApplyResult = { module: MODULE, applied: [], failed: [], skipped: [] };
  const mine = ops.filter((op) => op.module === MODULE);
  const cfg = ctx.account.oneuptime;
  let stopped: OpFailure | undefined;
  const client = cfg && mine.some((op) => op.action === "create" || op.action === "update")
    ? oneUptimeClient({ url: cfg.url, projectId: cfg.project_id, secrets: ctx.secrets, fetch: ctx.fetch, allowWrites: ctx.allowWrites })
    : undefined;

  for (const op of mine) {
    if (op.action === "report") {
      result.skipped.push({ op, reason: "report only" });
      continue;
    }
    if (op.action === "delete") {
      result.skipped.push({ op, reason: "monitors are never deleted by the tool" });
      continue;
    }
    if (stopped) {
      result.skipped.push({ op, reason: "an earlier monitor change failed" });
      continue;
    }
    try {
      if (!client) throw new Error("account.yaml has no oneuptime section");
      const want = wantFromView(op.after);
      const { project, parts } = opParts(op.ids ?? {});
      if (op.action === "create") {
        await client.request("POST", PATHS.monitorCreate, { body: { data: monitorData(want, project, {}, newId, true) } });
      } else {
        const monitorId = op.ids?.["monitorId"];
        if (!monitorId) throw new Error("monitor op is missing ids.monitorId");
        await client.request("PUT", PATHS.monitorUpdate(monitorId), { body: { data: monitorData(want, project, parts, newId, false) } });
      }
      result.applied.push(op);
    } catch (e) {
      stopped = { op, error: ctx.secrets.redact(errText(e)) };
      result.failed.push(stopped);
    }
  }
  return result;
}

export function createOneUptimeProvider(ctx: RunContext): Provider<OneUptimeObserved> {
  return {
    module: MODULE,
    observe: () => observeMonitors(ctx),
    diff: (desired, observed) => planMonitors(desired, observed),
    apply: (ops) => applyMonitors(ctx, ops),
  };
}
