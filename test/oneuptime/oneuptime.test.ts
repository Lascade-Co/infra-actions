import { beforeEach, describe, expect, it } from "vitest";
import { buildDesired, type DesiredState } from "../../src/core/desired.js";
import { WriteNotAllowedError } from "../../src/core/http.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import type { InfraConfig } from "../../src/core/model.js";
import type { PlanOp, RunContext } from "../../src/core/plan.js";
import { MissingSecretError, Secrets } from "../../src/core/secrets.js";
import { CRITERION, monitorData, PAGE_SIZE } from "../../src/oneuptime/api.js";
import {
  applyMonitors,
  createOneUptimeProvider,
  monitorDescription,
  observeMonitors,
  type OneUptimeObserved,
  ownedKey,
  planMonitors,
  projectIds,
} from "../../src/oneuptime/index.js";
import { exampleWith, observedDroplet } from "../helpers.js";
import {
  BASE,
  fakeOneUptime,
  type FakeOneUptime,
  POLICY_ID,
  PROJECT_ID,
  reserialise,
  SECRETS_ENV,
  SEVERITY_CRITICAL,
  STATUS_OFFLINE,
  STATUS_OPERATIONAL,
} from "./fake-oneuptime.js";

// The example checkout's monitors (defaults applied):
//   shop.example.com/healthcheck/, shop.example.net/healthcheck/ (public, deploy target)
//   staging-shop.example.com/healthcheck/ (staff, deploy target: bypassed)
//   tools.example.net/api/health (staff, /api open to a service token only: weak; accept app 404)
const EXAMPLE_KEYS = ["shop.example.com/healthcheck/", "shop.example.net/healthcheck/", "staging-shop.example.com/healthcheck/", "tools.example.net/api/health"];

async function config(changes: Record<string, string | null> = {}): Promise<InfraConfig> {
  const loaded = loadInfraFiles(await exampleWith(changes));
  if (!loaded.config) throw new Error(JSON.stringify(loaded.diagnostics));
  return loaded.config;
}

async function desired(changes: Record<string, string | null> = {}): Promise<DesiredState> {
  const c = await config(changes);
  const live = ["db.example.com", "shop.example.com", "tools.example.net", "worker.example.com"].map((n, i) => observedDroplet(n, { id: 100 + i }));
  return buildDesired(c, live);
}

function ctxFor(d: DesiredState, fake: FakeOneUptime, mode: RunContext["mode"] = "check", env: Record<string, string> = SECRETS_ENV): RunContext {
  return {
    mode,
    account: d.account,
    secrets: new Secrets(env),
    fetch: fake.fetch,
    allowWrites: mode === "apply",
    now: () => new Date(0),
    sleep: async () => {},
  };
}

const ids = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
let seq = 0;
const newId = () => ids(++seq);

/** A monitor the tool would have made for `key`, as the server stores it. */
function ownedRow(d: DesiredState, key: string, over: { acceptApp404?: boolean; url?: string; policies?: string[]; id?: string; type?: string } = {}): Record<string, any> {
  const droplet = d.droplets.find((x) => x.monitors.some((m) => `${m.hostname}${m.path}` === key))!;
  const data = monitorData(
    {
      name: key,
      description: monitorDescription(key, droplet.source),
      url: over.url ?? `https://${key}`,
      acceptApp404: over.acceptApp404 ?? droplet.monitors.find((m) => `${m.hostname}${m.path}` === key)!.acceptApp404,
      onCallPolicyIds: over.policies ?? [POLICY_ID],
    },
    { operationalStatusId: STATUS_OPERATIONAL, offlineStatusId: STATUS_OFFLINE, incidentSeverityId: SEVERITY_CRITICAL },
    {},
    newId,
    true,
  );
  return { _id: over.id ?? newId(), ...reserialise({ ...data, monitorType: over.type ?? data["monitorType"] }) };
}

describe("oneuptime observe", () => {
  let fake: FakeOneUptime;
  beforeEach(() => {
    fake = fakeOneUptime();
  });

  it("reads through Access with the API key and project headers, read-only, with an explicit select", async () => {
    const d = await desired();
    await observeMonitors(ctxFor(d, fake));
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/monitor/get-list",
      "POST /api/monitor-status/get-list",
      "POST /api/incident-severity/get-list",
      "POST /api/on-call-duty-policy/get-list",
    ]);
    for (const c of fake.calls) {
      expect(c.headers).toMatchObject({
        "cf-access-client-id": SECRETS_ENV.ONEUP_ACCESS_CLIENT_ID,
        "cf-access-client-secret": SECRETS_ENV.ONEUP_ACCESS_CLIENT_SECRET,
        apikey: SECRETS_ENV.ONEUPTIME_API_KEY,
        projectid: PROJECT_ID,
      });
      expect(c.query).toEqual({ skip: "0", limit: String(PAGE_SIZE) });
    }
    expect(fake.calls[0]!.body).toMatchObject({ query: {}, select: { _id: true, name: true, description: true, monitorType: true, monitorSteps: true, monitoringInterval: true } });
  });

  it("pages through long lists", async () => {
    const d = await desired();
    for (let i = 0; i < 230; i++) fake.monitors.push({ _id: ids(5000 + i), name: `foreign ${i}`, description: "made by hand" });
    const o = await observeMonitors(ctxFor(d, fake));
    expect(o.foreignCount).toBe(230);
    expect(fake.calls.filter((c) => c.path === "/api/monitor/get-list").map((c) => c.query["skip"])).toEqual(["0", "100", "200"]);
  });

  it("owns only monitors whose description starts with the marker word; counts the rest", async () => {
    const d = await desired();
    fake.monitors.push(
      ownedRow(d, "shop.example.com/healthcheck/", { id: ids(1) }),
      { _id: ids(2), name: "legacy.example.com/", description: "managed-by:infra-sync" },
      { _id: ids(3), name: "x", description: "managed-by:infra-sync2 other tool" },
      { _id: ids(4), name: "y", description: "see managed-by:infra-sync" },
      { _id: ids(5), name: "z" },
    );
    const o = await observeMonitors(ctxFor(d, fake));
    expect(o.owned.map((m) => [m.id, m.key, m.type])).toEqual([
      [ids(1), "shop.example.com/healthcheck/", "Website"],
      [ids(2), "legacy.example.com/", ""],
    ]);
    expect(o.owned[0]!.url).toBe("https://shop.example.com/healthcheck/");
    expect(o.foreignCount).toBe(3);
    expect(o.statuses.map((s) => s.name).sort()).toEqual(["Degraded", "Offline", "Operational"]);
    expect(o.onCallPolicyIds).toEqual([POLICY_ID]);
  });

  it("does nothing without account.oneuptime", async () => {
    const d = await desired();
    const { oneuptime: _, ...account } = d.account;
    const o = await observeMonitors({ ...ctxFor(d, fake), account, secrets: new Secrets({}) });
    expect(o).toEqual({ owned: [], foreignCount: 0, statuses: [], severities: [] });
    expect(fake.calls).toEqual([]);
  });

  it("keeps going when the key may not read on-call policies", async () => {
    const d = await desired();
    fake.failures.set("POST /api/on-call-duty-policy/get-list", 403);
    const o = await observeMonitors(ctxFor(d, fake));
    expect(o.onCallPolicyIds).toBeUndefined();
    expect(o.onCallPolicyReadError).toContain("HTTP 403");
    expect(planMonitors(d, o).diagnostics).toContainEqual(expect.objectContaining({ level: "warning", code: "oneuptime-on-call-policy" }));
  });

  it("fails naming the missing variable, never a value", async () => {
    const d = await desired();
    const p = observeMonitors(ctxFor(d, fake, "check", { ONEUPTIME_API_KEY: SECRETS_ENV.ONEUPTIME_API_KEY }));
    await expect(p).rejects.toBeInstanceOf(MissingSecretError);
    await expect(p).rejects.toThrow("ONEUP_ACCESS_CLIENT_ID");
    expect(fake.calls).toEqual([]);
  });

  it("ownedKey reads the key after the marker, else the name", () => {
    expect(ownedKey("managed-by:infra-sync a.example.com/x (droplets/a.example.com.yaml)", "n")).toBe("a.example.com/x");
    expect(ownedKey("managed-by:infra-sync", "n")).toBe("n");
    expect(ownedKey("managed-by:infra-sync note: paused for maintenance", "a.example.com/")).toBe("a.example.com/");
    expect(ownedKey("managed-by:infra-syncx", "n")).toBeUndefined();
    expect(ownedKey(undefined, "n")).toBeUndefined();
  });
});

describe("oneuptime plan", () => {
  let fake: FakeOneUptime;
  beforeEach(() => {
    fake = fakeOneUptime();
  });
  const observe = async (d: DesiredState) => observeMonitors(ctxFor(d, fake));

  it("creates one monitor per declared monitor, keyed <hostname><path>, with the droplet set", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observe(d));
    expect(plan.ops.map((o) => [o.action, o.key, o.droplet])).toEqual([
      ["create", "shop.example.com/healthcheck/", "shop.example.com"],
      ["create", "shop.example.net/healthcheck/", "shop.example.com"],
      ["create", "staging-shop.example.com/healthcheck/", "staging-shop.example.com"],
      ["create", "tools.example.net/api/health", "tools.example.net"],
    ]);
    const shop = plan.ops[0]!;
    expect(shop).toMatchObject({ provider: "oneuptime", module: "oneuptime", kind: "monitor", before: null });
    expect(shop.ids).toEqual({ operationalStatusId: STATUS_OPERATIONAL, offlineStatusId: STATUS_OFFLINE, incidentSeverityId: SEVERITY_CRITICAL });
    expect(shop.after).toEqual({
      name: "shop.example.com/healthcheck/",
      description: "managed-by:infra-sync shop.example.com/healthcheck/ (droplets/shop.example.com.yaml; edits made here are overwritten)",
      type: "Website",
      interval: "* * * * *",
      url: "https://shop.example.com/healthcheck/",
      method: "GET",
      followRedirects: false,
      acceptApp404: false,
      onCallPolicyIds: [POLICY_ID],
      defaultStatus: "Operational",
      steps: 1,
      criteria: [
        `${CRITERION.offline} [Any]: Is Online False; Response Status Code Greater Than Or Equal To 400; Response Status Code Less Than 200 -> status Offline -> incident "shop.example.com/healthcheck/ is down" (Critical Incident, auto-resolve, on-call ${POLICY_ID})`,
        `${CRITERION.online} [All]: Is Online True; Response Status Code Greater Than Or Equal To 200; Response Status Code Less Than 400 -> status Operational`,
      ],
    });
    expect(plan.unchanged).toBe(0);
  });

  it("accepts the app's 404 before the offline criteria, and only with a body that is not a Cloudflare error", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observe(d));
    const tools = plan.ops.find((o) => o.key === "tools.example.net/api/health")!.after as { acceptApp404: boolean; criteria: string[] };
    expect(tools.acceptApp404).toBe(true);
    expect(tools.criteria[0]).toBe(
      `${CRITERION.app404} [All]: Is Online True; Response Status Code Equal To 404; Response Body Not Contains error code: 1 -> status Operational`,
    );
    expect(tools.criteria[1]).toMatch(new RegExp(`^${CRITERION.offline}`));
  });

  it("warns when a monitor can only see the staff login", async () => {
    const d = await desired();
    const weak = planMonitors(d, await observe(d)).diagnostics.filter((x) => x.code === "monitor-health-weak");
    expect(weak).toEqual([expect.objectContaining({ level: "warning", droplet: "tools.example.net", file: "droplets/tools.example.net.yaml" })]);
    expect(weak[0]!.message).toContain("staff login (302)");
  });

  it("warns on a public site's health path under a protected path; not for an exception open to everyone", async () => {
    const d = await desired({
      "droplets/shop.example.com.yaml": [
        "name: shop.example.com",
        "env: prod",
        "deploy: true",
        "web:",
        "  exposure: public",
        "  health_path: /admin/health",
        "monitors:",
        "  - hostname: shop.example.com",
        "  - hostname: shop.example.com",
        "    path: /",
      ].join("\n"),
      "droplets/tools.example.net.yaml": [
        "name: tools.example.net",
        "env: internal",
        "web:",
        "  exposure: staff",
        "  health_path: /status",
        "  exceptions:",
        "    - path: /status",
        "      allow: everyone",
      ].join("\n"),
    });
    const weak = planMonitors(d, await observe(d)).diagnostics.filter((x) => x.code === "monitor-health-weak");
    expect(weak.map((w) => w.message)).toEqual([expect.stringContaining("/admin/health is under a protected path of shop.example.com")]);
  });

  it("is unchanged after apply: plan, apply, observe again, plan shows no ops", async () => {
    const d = await desired();
    const first = planMonitors(d, await observe(d));
    const res = await applyMonitors(ctxFor(d, fake, "apply"), first.ops, newId);
    expect(res.failed).toEqual([]);
    expect(res.applied).toHaveLength(4);
    const again = planMonitors(d, await observe(d));
    expect(again.ops).toEqual([]);
    expect(again.unchanged).toBe(4);
  });

  it("updates an owned monitor edited by hand, keeping its step, criteria and incident ids", async () => {
    const d = await desired();
    const row = ownedRow(d, "shop.example.com/healthcheck/", { id: ids(900), url: "https://shop.example.com/other", policies: [] });
    fake.monitors.push(row);
    const plan = planMonitors(d, await observe(d));
    const up = plan.ops.find((o) => o.action === "update")!;
    expect(up.key).toBe("shop.example.com/healthcheck/");
    expect(up.reason).toBe("url, onCallPolicyIds, criteria differ from droplets/shop.example.com.yaml");
    expect((up.before as { url: string }).url).toBe("https://shop.example.com/other");
    const step = (row.monitorSteps as any).value.monitorStepsInstanceArray[0].value;
    const crit = step.monitorCriteria.value.monitorCriteriaInstanceArray.map((c: any) => c.value);
    expect(up.ids).toEqual({
      operationalStatusId: STATUS_OPERATIONAL,
      offlineStatusId: STATUS_OFFLINE,
      incidentSeverityId: SEVERITY_CRITICAL,
      monitorId: ids(900),
      stepId: step.id,
      incidentId: crit[0].incidents[0].id,
      "criterion.offline": crit[0].id,
      "criterion.online": crit[1].id,
    });

    const res = await applyMonitors(ctxFor(d, fake, "apply"), [up], newId);
    expect(res.failed).toEqual([]);
    const put = fake.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe(`/api/monitor/${ids(900)}`);
    expect(put.body.data).not.toHaveProperty("monitorType");
    const sent = put.body.data.monitorSteps.value.monitorStepsInstanceArray[0].value;
    expect(sent.id).toBe(step.id);
    expect(sent.monitorCriteria.value.monitorCriteriaInstanceArray.map((c: any) => c.value.id)).toEqual([crit[0].id, crit[1].id]);
    expect(sent.monitorDestination).toEqual({ _type: "URL", value: "https://shop.example.com/healthcheck/" });
    expect(planMonitors(d, await observe(d)).ops.filter((o) => o.action !== "create")).toEqual([]);
  });

  it("turning accept-app-404 on adds the criteria, with fresh ids, in front", async () => {
    const d = await desired();
    fake.monitors.push(ownedRow(d, "tools.example.net/api/health", { id: ids(901), acceptApp404: false }));
    const up = planMonitors(d, await observe(d)).ops.find((o) => o.action === "update")!;
    expect(up.reason).toBe("acceptApp404, criteria differ from droplets/tools.example.net.yaml");
    await applyMonitors(ctxFor(d, fake, "apply"), [up], newId);
    const sent = fake.calls.find((c) => c.method === "PUT")!.body.data.monitorSteps.value.monitorStepsInstanceArray[0].value;
    const names = sent.monitorCriteria.value.monitorCriteriaInstanceArray.map((c: any) => c.value.name);
    expect(names).toEqual([CRITERION.app404, CRITERION.offline, CRITERION.online]);
  });

  it("reports owned monitors no file wants, duplicates and a wrong type; never deletes; ignores foreign ones", async () => {
    const d = await desired();
    fake.monitors.push(
      ownedRow(d, "shop.example.com/healthcheck/", { id: ids(10) }),
      ownedRow(d, "shop.example.com/healthcheck/", { id: ids(11) }),
      ownedRow(d, "shop.example.net/healthcheck/", { id: ids(12), type: "API" }),
      { _id: ids(13), name: "old.example.com/", description: "managed-by:infra-sync old.example.com/ (droplets/old.example.com.yaml)" },
      { _id: ids(14), name: "staging-shop.example.com/healthcheck/", description: "hand-made, same URL" },
    );
    const plan = planMonitors(d, await observe(d));
    expect(plan.ops.map((o) => [o.action, o.key, o.ids?.["monitorId"] ?? null])).toEqual([
      ["create", "staging-shop.example.com/healthcheck/", null],
      ["create", "tools.example.net/api/health", null],
      ["report", "old.example.com/", ids(13)],
      ["report", "shop.example.com/healthcheck/", ids(11)],
      ["report", "shop.example.net/healthcheck/", ids(12)],
    ]);
    expect(plan.unchanged).toBe(1);
    const reasons = plan.ops.filter((o) => o.action === "report").map((o) => o.reason);
    expect(reasons[0]).toContain("delete it by hand");
    expect(reasons[1]).toContain("duplicate");
    expect(reasons[2]).toContain("can't change a monitor's type");
    expect(plan.ops.some((o) => o.action === "delete")).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(ids(14));
  });

  it("empty plan with an info diagnostic without account.oneuptime", async () => {
    const d = await desired();
    const { oneuptime: _, ...account } = d.account;
    const plan = planMonitors({ ...d, account }, { owned: [], foreignCount: 0, statuses: [], severities: [] });
    expect(plan).toEqual({ module: "oneuptime", ops: [], unchanged: 0, diagnostics: [expect.objectContaining({ level: "info", code: "oneuptime-not-configured" })] });
  });

  it("errors when the project has no offline status or no severity", async () => {
    const d = await desired();
    fake.statuses = fake.statuses.filter((s) => s["isOfflineState"] !== true);
    fake.severities = [];
    const o = await observe(d);
    expect(projectIds(o).missing).toEqual(["a monitor status marked offline", "an incident severity"]);
    const plan = planMonitors(d, o);
    expect(plan.ops).toEqual([]);
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "oneuptime-project" }));
  });

  it("errors on an on-call policy id the project doesn't have", async () => {
    const d = await desired();
    fake.policies = [];
    const plan = planMonitors(d, await observe(d));
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "oneuptime-on-call-policy" }));
  });

  it("errors when two droplet files declare the same monitor", async () => {
    // The loader and checks catch this earlier; the plan still never makes two.
    const d = await desired();
    const worker = d.droplets.find((x) => x.name === "worker.example.com")!;
    worker.monitors = [{ type: "http", hostname: "shop.example.com", path: "/healthcheck/", acceptApp404: false }];
    const plan = planMonitors(d, await observe(d));
    expect(plan.diagnostics).toContainEqual(expect.objectContaining({ level: "error", code: "duplicate-monitor", droplet: "worker.example.com" }));
    expect(plan.ops.filter((o) => o.key === "shop.example.com/healthcheck/")).toHaveLength(1);
  });

  it("plans no monitor for `monitors: []`", async () => {
    const d = await desired();
    expect(planMonitors(d, await observe(d)).ops.some((o) => o.droplet === "db.example.com")).toBe(false);
  });

  it("plans the same keys as the example lists", async () => {
    const d = await desired();
    expect(planMonitors(d, await observe(d)).ops.map((o) => o.key)).toEqual(EXAMPLE_KEYS);
  });
});

describe("oneuptime apply", () => {
  let fake: FakeOneUptime;
  beforeEach(() => {
    fake = fakeOneUptime();
  });

  it("creates with the documented wire format", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observeMonitors(ctxFor(d, fake)));
    await applyMonitors(ctxFor(d, fake, "apply"), plan.ops.slice(0, 1), newId);
    const post = fake.calls.find((c) => c.method === "POST" && c.path === "/api/monitor")!;
    expect(post.headers["apikey"]).toBe(SECRETS_ENV.ONEUPTIME_API_KEY);
    const data = post.body.data;
    expect(data).toMatchObject({ name: "shop.example.com/healthcheck/", monitorType: "Website", monitoringInterval: "* * * * *" });
    expect(data.monitorSteps._type).toBe("MonitorSteps");
    expect(data.monitorSteps.value.defaultMonitorStatusId).toBe(STATUS_OPERATIONAL);
    const step = data.monitorSteps.value.monitorStepsInstanceArray[0];
    expect(step._type).toBe("MonitorStep");
    expect(step.value).toMatchObject({ requestType: "GET", doNotFollowRedirects: true, monitorDestination: { _type: "URL", value: "https://shop.example.com/healthcheck/" } });
    expect(step.value.id).toMatch(/^[0-9a-f-]{36}$/);
    const [offline, online] = step.value.monitorCriteria.value.monitorCriteriaInstanceArray;
    expect(offline.value).toMatchObject({ monitorStatusId: STATUS_OFFLINE, createIncidents: true, createAlerts: false });
    expect(offline.value.incidents[0]).toMatchObject({ incidentSeverityId: SEVERITY_CRITICAL, onCallPolicyIds: [POLICY_ID], autoResolveIncident: true });
    expect(online.value).toMatchObject({ monitorStatusId: STATUS_OPERATIONAL, createIncidents: false });
  });

  it("refuses to write in a read-only run", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observeMonitors(ctxFor(d, fake)));
    const before = fake.calls.length;
    const res = await applyMonitors(ctxFor(d, fake, "check"), plan.ops, newId);
    expect(res.applied).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.error).toContain(new WriteNotAllowedError("POST", "/monitor").message);
    expect(res.skipped).toHaveLength(3);
    expect(fake.calls.length).toBe(before);
  });

  it("stops at the first failure and skips report and delete ops", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observeMonitors(ctxFor(d, fake)));
    const [a, b, c] = plan.ops;
    const report: PlanOp = { ...a!, action: "report", reason: "test" };
    const del: PlanOp = { ...a!, action: "delete", reason: "test" };
    fake.failures.set("POST /api/monitor", 500);
    const res = await applyMonitors(ctxFor(d, fake, "apply"), [report, del, a!, b!, c!], newId);
    expect(res.applied).toEqual([]);
    expect(res.failed.map((f) => f.op.key)).toEqual([a!.key]);
    expect(res.failed[0]!.error).toBe("oneuptime POST /monitor: HTTP 500 (You do not have permission to do this)");
    expect(res.skipped.map((s) => s.reason)).toEqual(["report only", "monitors are never deleted by the tool", "an earlier monitor change failed", "an earlier monitor change failed"]);
    expect(fake.calls.filter((x) => x.method === "POST" && x.path === "/api/monitor")).toHaveLength(1);
  });

  it("never puts a secret in an error", async () => {
    const d = await desired();
    const plan = planMonitors(d, await observeMonitors(ctxFor(d, fake)));
    const leaky: RunContext = {
      ...ctxFor(d, fake, "apply"),
      fetch: async () => {
        throw new Error(`connect failed with ${SECRETS_ENV.ONEUPTIME_API_KEY}`);
      },
    };
    const res = await applyMonitors(leaky, plan.ops.slice(0, 1), newId);
    expect(res.failed[0]!.error).toBe("connect failed with ***");
  });

  it("the provider wires observe, diff and apply", async () => {
    const d = await desired();
    const p = createOneUptimeProvider(ctxFor(d, fake, "apply"));
    const o: OneUptimeObserved = await p.observe(d);
    const plan = p.diff(d, o);
    const res = await p.apply(plan.ops, o);
    expect(res.applied).toHaveLength(EXAMPLE_KEYS.length);
    expect(fake.monitors.map((m) => m["name"])).toEqual(EXAMPLE_KEYS);
    expect(new URL(fake.calls[0]!.path, BASE).origin).toBe(BASE);
  });
});
