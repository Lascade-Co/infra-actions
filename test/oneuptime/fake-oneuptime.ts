// An in-memory OneUptime for B5's tests: the routes, headers and list format of OneUptime's REST
// API, and a read-back that re-serialises what was written the way the server does (ObjectIDs as
// { _type, value }, filter values as strings, ids filled in, extra default fields). Fake data only.

import type { FetchFn } from "../../src/core/http.js";

export const BASE = "https://status.example.com";
export const PROJECT_ID = "00000000-0000-4000-8000-000000000201";
export const POLICY_ID = "00000000-0000-4000-8000-000000000202";
export const STATUS_OPERATIONAL = "00000000-0000-4000-8000-000000000301";
export const STATUS_DEGRADED = "00000000-0000-4000-8000-000000000302";
export const STATUS_OFFLINE = "00000000-0000-4000-8000-000000000303";
export const SEVERITY_CRITICAL = "00000000-0000-4000-8000-000000000401";
export const SEVERITY_MINOR = "00000000-0000-4000-8000-000000000402";

export const SECRETS_ENV = {
  ONEUPTIME_API_KEY: "fake-oneuptime-key-0001",
  ONEUP_ACCESS_CLIENT_ID: "fake-access-id.access",
  ONEUP_ACCESS_CLIENT_SECRET: "fake-access-secret-0002",
};

type Row = Record<string, unknown>;

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: any;
}

export interface FakeOneUptime {
  fetch: FetchFn;
  calls: Call[];
  monitors: Row[];
  statuses: Row[];
  severities: Row[];
  policies: Row[];
  /** Status to answer for a path (e.g. 403 on the on-call policy list). */
  failures: Map<string, number>;
}

let counter = 0;
const newId = () => `00000000-0000-4000-9000-${String(++counter).padStart(12, "0")}`;

const oid = (v: unknown) => (typeof v === "string" ? { _type: "ObjectID", value: v } : v);

/** What OneUptime stores and returns for a written monitor (roughly MonitorSteps.fromJSON + toJSON). */
export function reserialise(data: Row): Row {
  const steps = data["monitorSteps"] as { value: { monitorStepsInstanceArray: Array<{ value: Row }>; defaultMonitorStatusId?: string } } | undefined;
  if (!steps) return { ...data };
  return {
    ...data,
    monitorSteps: {
      _type: "MonitorSteps",
      value: {
        defaultMonitorStatusId: steps.value.defaultMonitorStatusId,
        monitorStepsInstanceArray: steps.value.monitorStepsInstanceArray.map((s) => {
          const crit = (s.value["monitorCriteria"] as { value: { monitorCriteriaInstanceArray: Array<{ value: Row }> } }).value.monitorCriteriaInstanceArray;
          return {
            _type: "MonitorStep",
            value: {
              ...s.value,
              requestHeaders: undefined,
              monitorCriteria: {
                _type: "MonitorCriteria",
                value: {
                  monitorCriteriaInstanceArray: crit.map((c) => ({
                    _type: "MonitorCriteriaInstance",
                    value: {
                      ...c.value,
                      id: (c.value["id"] as string) || newId(),
                      isEnabled: true,
                      filters: (c.value["filters"] as Row[]).map((f) => ({ ...f, ...(f["value"] !== undefined ? { value: String(f["value"]) } : {}) })),
                      incidents: (c.value["incidents"] as Row[]).map((i) => ({
                        ...i,
                        incidentSeverityId: oid(i["incidentSeverityId"]),
                        onCallPolicyIds: ((i["onCallPolicyIds"] as unknown[]) ?? []).map(oid),
                      })),
                    },
                  })),
                },
              },
            },
          };
        }),
      },
    },
  };
}

export function fakeOneUptime(): FakeOneUptime {
  const state: FakeOneUptime = {
    fetch: undefined as unknown as FetchFn,
    calls: [],
    monitors: [],
    statuses: [
      { _id: STATUS_DEGRADED, name: "Degraded", isOperationalState: false, isOfflineState: false, priority: 2 },
      { _id: STATUS_OFFLINE, name: "Offline", isOperationalState: false, isOfflineState: true, priority: 3 },
      { _id: STATUS_OPERATIONAL, name: "Operational", isOperationalState: true, isOfflineState: false, priority: 1 },
    ],
    severities: [
      { _id: SEVERITY_MINOR, name: "Minor Incident", order: 3 },
      { _id: SEVERITY_CRITICAL, name: "Critical Incident", order: 1 },
    ],
    policies: [{ _id: POLICY_ID, name: "Example on-call" }],
    failures: new Map(),
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const list = (rows: Row[], q: Record<string, string>, select: Record<string, boolean> | undefined) => {
    const skip = Number(q["skip"] ?? 0);
    const limit = Number(q["limit"] ?? 10);
    const fields = Object.keys(select ?? { _id: true });
    const data = rows.slice(skip, skip + limit).map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])));
    return json(200, { count: rows.length, skip, limit, data });
  };

  state.fetch = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname;
    state.calls.push({ method, path, query: Object.fromEntries(url.searchParams), headers, body });

    if (url.origin !== BASE) return json(404, { message: "unknown host" });
    if (headers["cf-access-client-id"] !== SECRETS_ENV.ONEUP_ACCESS_CLIENT_ID || headers["cf-access-client-secret"] !== SECRETS_ENV.ONEUP_ACCESS_CLIENT_SECRET) {
      return new Response("<html>Sign in</html>", { status: 403 });
    }
    if (headers["apikey"] !== SECRETS_ENV.ONEUPTIME_API_KEY) return json(400, { message: "Invalid API Key" });
    const fail = state.failures.get(`${method} ${path}`);
    if (fail) return json(fail, { message: "You do not have permission to do this" });

    const q = Object.fromEntries(url.searchParams);
    if (method === "POST" && path === "/api/monitor/get-list") return list(state.monitors, q, body?.select);
    if (method === "POST" && path === "/api/monitor-status/get-list") return list(state.statuses, q, body?.select);
    if (method === "POST" && path === "/api/incident-severity/get-list") return list(state.severities, q, body?.select);
    if (method === "POST" && path === "/api/on-call-duty-policy/get-list") return list(state.policies, q, body?.select);
    if (method === "POST" && path === "/api/monitor") {
      const row = { _id: newId(), ...reserialise(body.data) };
      state.monitors.push(row);
      return json(200, row);
    }
    const m = /^\/api\/monitor\/([^/]+)$/.exec(path);
    if (method === "PUT" && m) {
      const i = state.monitors.findIndex((r) => r["_id"] === m[1]);
      if (i < 0) return json(404, { message: "Monitor not found" });
      if ("monitorType" in body.data) return json(400, { message: "monitorType can't be updated" });
      state.monitors[i] = { ...state.monitors[i], ...reserialise(body.data) };
      return json(200, {});
    }
    return json(404, { message: `no route ${method} ${path}` });
  };
  return state;
}
