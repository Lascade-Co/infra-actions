// Per-droplet SSH access (decision 18): one Access for Infrastructure app per distinct access set,
// targets tagged with their set, and the migration from the Worker's single app without ever
// leaving a droplet with no app. Everything here is fake (example.com, 10.0.x.x, placeholder ids).

import { describe, expect, it } from "vitest";
import { renderPrComment } from "../../src/output/markdown.js";
import { newReport } from "../../src/core/report.js";
import type { AccountConfig } from "../../src/core/model.js";
import { ADMINS, changes, droplet, FakeCloudflare, opKeys, planOnly, run, testAccount, type Call } from "./fake.js";

const DEV = "dev@example.com";

function account(groups: Record<string, string[]> = { admins: [...ADMINS], devs: [DEV] }): AccountConfig {
  return { ...testAccount(), ssh_groups: groups };
}

/** Three droplets: a and b for the admins, c for the admins and a developer (two access sets). */
function threeDroplets(): FakeCloudflare {
  const f = new FakeCloudflare();
  f.droplets = [
    droplet(1, "a.example.com", "nyc1", "10.0.0.2", ["env-prod"]),
    droplet(2, "b.example.com", "nyc1", "10.0.0.3", ["env-prod"]),
    droplet(3, "c.example.com", "nyc1", "10.0.0.4", ["env-prod"]),
  ];
  f.ssh["c.example.com"] = ["admins", "devs"];
  return f;
}

const infraApps = (f: FakeCloudflare) => f.apps.filter((a) => a.type === "infrastructure");
const emailsOf = (a: { policies?: Array<{ include?: unknown[] }> }) =>
  (a.policies ?? []).flatMap((p) => (p.include ?? []).map((r) => (r as { email?: { email: string } }).email?.email)).filter(Boolean).sort();
const target = (f: FakeCloudflare, name: string) => f.targets.find((t) => t.hostname === name)!;

/** Targets that no infrastructure app selects (every tag key of a criterion must match). Written independently of src/. */
function uncovered(f: FakeCloudflare): string[] {
  return f.targets
    .filter(
      (t) =>
        !infraApps(f).some((a) =>
          (a.target_criteria ?? []).some((c) => {
            const tags = (c as { include?: { tags?: Record<string, string[]> } }).include?.tags ?? {};
            const keys = Object.keys(tags);
            return keys.length > 0 && keys.every((k) => t.tags?.[k] !== undefined && tags[k]!.includes(t.tags[k]!));
          }),
        ),
    )
    .map((t) => t.hostname)
    .sort();
}

/** Records, after every write, the targets left with no infrastructure app. */
function watchCoverage(f: FakeCloudflare): string[] {
  const gaps: string[] = [];
  const inner = f.fetch;
  f.fetch = async (input: string, init?: RequestInit) => {
    const res = await inner(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      const g = uncovered(f);
      if (g.length) gaps.push(`${method} ${new URL(input).pathname}: ${g.join(", ")}`);
    }
    return res;
  };
  return gaps;
}

/**
 * Turns what the tool built into what the Worker built: its single infrastructure app (every
 * admin, as ubuntu and root, on every target tagged managed-by=infra-sync) and targets with only
 * that tag. Written literally, not from the constants under test.
 */
function toWorkerState(f: FakeCloudflare) {
  f.apps = f.apps.filter((a) => a.type !== "infrastructure");
  f.apps.push({
    id: "worker-infra-app",
    name: "infra-sync: SSH targets",
    type: "infrastructure",
    target_criteria: [{ port: 22, protocol: "SSH", include: { tags: { "managed-by": ["infra-sync"] } } }],
    policies: [
      {
        id: "worker-policy",
        name: "infra-sync: ssh-admins",
        decision: "allow",
        include: ADMINS.map((email) => ({ email: { email } })),
        connection_rules: { ssh: { usernames: ["root", "ubuntu"] } },
        precedence: 1,
      },
    ],
  });
  for (const t of f.targets) t.tags = { "managed-by": "infra-sync" };
}

/** The Worker's state for three droplets that all had the admins. */
async function workerState(): Promise<FakeCloudflare> {
  const f = threeDroplets();
  f.ssh = {};
  await run(f, { account: account() });
  toWorkerState(f);
  expect(uncovered(f)).toEqual([]);
  f.calls = [];
  return f;
}

const writeIndex = (calls: Call[], pred: (c: Call) => boolean) => calls.filter((c) => c.method !== "GET").findIndex(pred);
const isInfraAppPost = (c: Call) => c.method === "POST" && c.path.endsWith("/access/apps") && c.body?.type === "infrastructure";
const isTargetPut = (c: Call) => c.method === "PUT" && c.path.includes("/infrastructure/targets/");
const isAppDelete = (id: string) => (c: Call) => c.method === "DELETE" && c.path.endsWith(`/access/apps/${id}`);

describe("SSH access sets", () => {
  it("builds one infrastructure app per distinct access set: 3 droplets, 2 sets, 2 apps; a re-plan has no changes", async () => {
    const f = threeDroplets();
    const r = await run(f, { account: account() });
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);

    const apps = infraApps(f);
    expect(apps).toHaveLength(2);
    const admins = apps.find((a) => emailsOf(a).length === 2)!;
    const withDev = apps.find((a) => emailsOf(a).length === 3)!;
    expect(emailsOf(admins)).toEqual([...ADMINS].sort());
    expect(emailsOf(withDev)).toEqual([...ADMINS, DEV].sort());

    // a and b share one set; c has its own. Each app selects its set's tag on port 22, as ubuntu only.
    const setOf = (name: string) => target(f, name).tags!["ssh-access"]!;
    expect(setOf("a.example.com")).toMatch(/^[0-9a-f]{12}$/);
    expect(setOf("a.example.com")).toBe(setOf("b.example.com"));
    expect(setOf("c.example.com")).not.toBe(setOf("a.example.com"));
    for (const [app, set] of [
      [admins, setOf("a.example.com")],
      [withDev, setOf("c.example.com")],
    ] as const) {
      expect(app.name).toBe(`infra-sync: SSH ${set}`);
      expect(app.target_criteria).toEqual([{ port: 22, protocol: "SSH", include: { tags: { "ssh-access": [set] } } }]);
      expect(app.policies).toHaveLength(1);
      expect(app.policies![0]).toMatchObject({ decision: "allow", connection_rules: { ssh: { usernames: ["ubuntu"] } } });
    }
    // Targets keep the ownership tag.
    expect(target(f, "c.example.com").tags).toEqual({ "managed-by": "infra-sync", "ssh-access": setOf("c.example.com") });

    // Each droplet's ssh- route app lets in the same people.
    expect(emailsOf(f.apps.find((a) => a.domain === "ssh-c.example.com")!)).toEqual([...ADMINS, DEV].sort());
    expect(emailsOf(f.apps.find((a) => a.domain === "ssh-a.example.com")!)).toEqual([...ADMINS].sort());

    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it("the set id depends only on the people, not on how they are listed", async () => {
    const f = threeDroplets();
    // The same people as c, written as single emails in another order and case.
    f.ssh["a.example.com"] = [DEV.toUpperCase().replace("EXAMPLE.COM", "example.com"), ...ADMINS].reverse();
    await run(f, { account: account() });
    expect(target(f, "a.example.com").tags!["ssh-access"]).toBe(target(f, "c.example.com").tags!["ssh-access"]);
    expect(infraApps(f)).toHaveLength(2);
  });

  it("keeps tags the tool doesn't manage on a target it retags", async () => {
    const f = threeDroplets();
    await run(f, { account: account() });
    target(f, "a.example.com").tags = { ...target(f, "a.example.com").tags, team: "storefront" };
    f.ssh["a.example.com"] = ["devs"];
    await run(f, { account: account() });
    expect(target(f, "a.example.com").tags).toMatchObject({ team: "storefront", "managed-by": "infra-sync" });
  });
});

describe("migration from the Worker's single app", () => {
  it("moves every droplet to its set's app and deletes the Worker's app; no droplet is ever without an app", async () => {
    const f = await workerState();
    f.ssh["c.example.com"] = ["admins", "devs"];
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    expect(gaps).toEqual([]);

    // Order: the set apps, then the retags, then the Worker's app goes.
    const w = f.calls;
    const lastAppPost = Math.max(...w.filter((c) => c.method !== "GET").map((c, i) => (isInfraAppPost(c) ? i : -1)));
    const firstRetag = writeIndex(w, isTargetPut);
    const workerDelete = writeIndex(w, isAppDelete("worker-infra-app"));
    expect(lastAppPost).toBeGreaterThanOrEqual(0);
    expect(lastAppPost).toBeLessThan(firstRetag);
    expect(workerDelete).toBeGreaterThan(firstRetag);
    expect(w.filter((c) => c.method !== "GET").slice(workerDelete + 1).some(isTargetPut)).toBe(false);

    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(false);
    expect(infraApps(f)).toHaveLength(2);
    expect(uncovered(f)).toEqual([]);

    // The plan said who gains and loses what, per droplet, and that root goes.
    const t = r.plan.ops.find((o) => o.kind === "infra-target" && o.key === "c.example.com")!;
    expect(t.sshAccess).toEqual({
      before: { emails: [...ADMINS].sort(), usernames: ["root", "ubuntu"] },
      after: { emails: [...ADMINS, DEV].sort(), usernames: ["ubuntu"] },
    });
    expect(r.plan.ops.find((o) => o.kind === "infra-app" && o.key === "infra-sync: SSH targets")?.action).toBe("delete");

    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it("the PR comment shows each droplet's SSH access change and the root removal once", async () => {
    const f = await workerState();
    f.ssh["c.example.com"] = ["admins", "devs"];
    f.ssh["b.example.com"] = ["devs"];
    const plan = await planOnly(f, account());
    const report = newReport("check", new Date("2026-11-19T04:00:00Z"));
    report.dropletFiles = 3;
    report.plans = [plan];
    const md = renderPrComment(report);
    const at = (s: string) => s.replace(/@/g, "@​");
    expect(md).toContain(`- **SSH access:** ${at(`gains ${DEV}`)}, as \`ubuntu\``);
    expect(md).toContain(`- **SSH access:** ${at(`gains ${DEV}; loses ${[...ADMINS].sort().join(", ")}`)}, as \`ubuntu\``);
    expect(md).toContain("- **SSH access:** the same people, as `ubuntu`");
    expect(md.match(/Root SSH login is removed/g)).toHaveLength(1);
    expect(md).toContain("Root SSH login is removed on 3 droplet(s).");
  });

  it("moves a frozen droplet to its set's app too and deletes the Worker's app once every droplet is covered", async () => {
    const f = await workerState();
    f.frozen.add("b.example.com");
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(r.result.failed).toEqual([]);
    expect(gaps).toEqual([]);
    expect(target(f, "b.example.com").tags!["ssh-access"]).toBe(target(f, "a.example.com").tags!["ssh-access"]);
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(false);
    expect(r.warnings.join("\n")).not.toMatch(/is kept/);
    const b = r.plan.ops.find((o) => o.kind === "infra-target" && o.key === "b.example.com")!;
    expect(b.action).toBe("update");
    expect(b.reason).toMatch(/^frozen: only SSH access changes are applied: /);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it("a frozen droplet gets only its SSH access changed: its target's tag and its ssh- app's people; the rest is planned, not applied", async () => {
    const f = await workerState();
    f.frozen.add("b.example.com");
    f.ssh["b.example.com"] = ["devs"];
    // Other changes for b: a new private IP (target, ssh- route, vpc- record) and deploy (CI tokens on its ssh- app, a healthcheck app).
    f.droplets = f.droplets.map((d) => (d.name === "b.example.com" ? { ...d, privateIp: "10.0.0.33", tags: [...d.tags, "ci-deploy"] } : d));
    const acct = { ...account(), cloudflare: { ...account().cloudflare, ci_deploy_tokens: { ...account().cloudflare.ci_deploy_tokens, prod: ["ci-staging"] } } };
    const appBefore = structuredClone(f.apps.find((a) => a.domain === "ssh-b.example.com")!);
    const tunnelsBefore = structuredClone(f.tunnels);
    const vpcBefore = structuredClone(Object.values(f.dns).flat().find((x) => x.name === "vpc-b.example.com"));
    const gaps = watchCoverage(f);
    const r = await run(f, { account: acct });
    expect(r.result.failed).toEqual([]);
    expect(gaps).toEqual([]);

    // Applied: the tag (IP and hostname untouched) and the people on the ssh- app (its other policies untouched).
    const t = target(f, "b.example.com");
    expect(t.ip.ipv4?.ip_addr).toBe("10.0.0.3");
    expect(t.tags!["ssh-access"]).toMatch(/^[0-9a-f]{12}$/);
    expect(t.tags!["ssh-access"]).not.toBe(target(f, "a.example.com").tags!["ssh-access"]);
    expect(infraApps(f).find((a) => a.name === `infra-sync: SSH ${t.tags!["ssh-access"]}`)).toBeDefined();
    expect(emailsOf(infraApps(f).find((a) => a.name === `infra-sync: SSH ${t.tags!["ssh-access"]}`)!)).toEqual([DEV]);
    const app = f.apps.find((a) => a.domain === "ssh-b.example.com")!;
    expect(emailsOf(app)).toEqual([DEV]);
    expect(app.policies!.map((p) => [p.id, p.name, p.decision])).toEqual(appBefore.policies!.map((p) => [p.id, p.name, p.decision]));
    expect(app.policies!.some((p) => p.decision === "non_identity")).toBe(false);

    // Not applied: route, vpc- record, healthcheck app, the IP on the target, the CI tokens.
    expect(f.tunnels).toEqual(tunnelsBefore);
    expect(Object.values(f.dns).flat().find((x) => x.name === "vpc-b.example.com")).toEqual(vpcBefore);
    expect(f.apps.some((a) => (a.domain ?? "").startsWith("b.example.com/"))).toBe(false);
    const reports = opKeys(r.plan, "report");
    expect(reports).toEqual(
      expect.arrayContaining([
        "report infra-target b.example.com (beyond SSH access)",
        "report access-app ssh-b.example.com (beyond SSH access)",
        "report dns-record A vpc-b.example.com",
        "report access-app b.example.com/healthcheck",
      ]),
    );
    expect(r.plan.ops.filter((o) => o.droplet === "b.example.com" && o.action !== "report").map((o) => `${o.kind} ${o.key}`).sort()).toEqual(
      ["access-app ssh-b.example.com", "infra-target b.example.com"],
    );
    // The Worker's app goes: every droplet, the frozen one included, is on its set's app.
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(false);

    // The PR comment shows the frozen droplet's SSH change as the allowed exception.
    const report = newReport("check", new Date("2026-11-19T04:00:00Z"));
    report.plans = [r.plan];
    const md = renderPrComment(report);
    const section = md.slice(md.indexOf("### Changes the apply will make"));
    expect(section).toContain("frozen: only SSH access changes are applied: the droplet's SSH access set changed");
    expect(section).toContain("frozen: only SSH access changes are applied: the people on the droplet's SSH route changed");
    expect(md).toContain("frozen droplet, would update: the droplet's private IP changed");

    // A re-plan: SSH access is done; only the frozen droplet's other changes remain, as reports.
    const again = await planOnly(f, acct);
    expect(changes(again)).toEqual([]);
    expect(again.ops.filter((o) => o.droplet === "b.example.com").every((o) => o.action === "report")).toBe(true);
  });

  it("a frozen droplet's failed retag keeps the Worker's app, so it stays covered", async () => {
    const f = await workerState();
    f.frozen.add("b.example.com");
    const bId = target(f, "b.example.com").id;
    f.failWhen((c) => (c.method === "PUT" && c.path.endsWith(`/infrastructure/targets/${bId}`) ? { status: 500 } : undefined));
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(gaps).toEqual([]);
    expect(r.result.failed.map((x) => `${x.op.kind} ${x.op.key}`)).toEqual(["infra-target b.example.com"]);
    expect(r.result.skipped.map((x) => `${x.op.kind} ${x.op.key}`)).toContain("infra-app infra-sync: SSH targets");
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(true);
    expect(target(f, "b.example.com").tags).toEqual({ "managed-by": "infra-sync" });
  });

  it("keeps the Worker's app for a droplet that has no file", async () => {
    const f = await workerState();
    f.noFile.add("b.example.com");
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(gaps).toEqual([]);
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/b\.example\.com \(not managed this run\)/);
  });

  it("a failed retag keeps the Worker's app (its delete waits for every retag)", async () => {
    const f = await workerState();
    const bId = target(f, "b.example.com").id;
    f.failWhen((c) => (c.method === "PUT" && c.path.endsWith(`/infrastructure/targets/${bId}`) ? { status: 500 } : undefined));
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(gaps).toEqual([]);
    expect(r.result.failed.map((x) => `${x.op.kind} ${x.op.key}`)).toEqual(["infra-target b.example.com"]);
    expect(r.result.skipped.map((x) => `${x.op.kind} ${x.op.key}`)).toContain("infra-app infra-sync: SSH targets");
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(true);
    expect(f.calls.some(isAppDelete("worker-infra-app"))).toBe(false);
  });

  it("a failed set app create leaves its droplets on the Worker's app (their retag waits for it)", async () => {
    const f = await workerState();
    f.failWhen((c) => (isInfraAppPost(c) ? { status: 500 } : undefined));
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(gaps).toEqual([]);
    expect(f.calls.some(isTargetPut)).toBe(false);
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(true);
    expect(r.result.skipped.map((x) => `${x.op.kind} ${x.op.key}`)).toEqual(
      expect.arrayContaining(["infra-target a.example.com", "infra-target b.example.com", "infra-target c.example.com", "infra-app infra-sync: SSH targets"]),
    );
  });

  it("with deletions blocked, the Worker's app stays as a report op and the plan says root stays", async () => {
    const f = await workerState();
    const acct = { ...account(), cloudflare: { ...account().cloudflare, guards: { max_deletes: 0, max_delete_fraction: 0.3 } } };
    const gaps = watchCoverage(f);
    const r = await run(f, { account: acct });
    expect(gaps).toEqual([]);
    expect(opKeys(r.plan, "report")).toContain("report infra-app infra-sync: SSH targets");
    expect(f.apps.some((a) => a.id === "worker-infra-app")).toBe(true);
    // The Worker's app stays, so the admins keep root: no SSH access change to show.
    expect(r.plan.ops.find((o) => o.kind === "infra-target" && o.key === "a.example.com")?.sshAccess).toBeUndefined();
  });
});

describe("moving a droplet between access sets", () => {
  it("creates the new set's app before the retag and deletes the old set's app after it; no gap", async () => {
    const f = threeDroplets();
    await run(f, { account: account() });
    const oldSet = target(f, "c.example.com").tags!["ssh-access"]!;
    const oldApp = infraApps(f).find((a) => a.name === `infra-sync: SSH ${oldSet}`)!;
    f.calls = [];

    // c: admins + dev -> dev only (a set no droplet has yet).
    f.ssh["c.example.com"] = ["devs"];
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(r.result.failed).toEqual([]);
    expect(gaps).toEqual([]);
    const newSet = target(f, "c.example.com").tags!["ssh-access"]!;
    expect(newSet).not.toBe(oldSet);
    const post = writeIndex(f.calls, isInfraAppPost);
    const retag = writeIndex(f.calls, isTargetPut);
    const del = writeIndex(f.calls, isAppDelete(oldApp.id));
    expect(post).toBeGreaterThanOrEqual(0);
    expect(post).toBeLessThan(retag);
    expect(retag).toBeLessThan(del);
    expect(infraApps(f).map((a) => a.name).sort()).toEqual([`infra-sync: SSH ${newSet}`, `infra-sync: SSH ${target(f, "a.example.com").tags!["ssh-access"]}`].sort());
    expect(r.plan.ops.find((o) => o.kind === "infra-target")?.sshAccess).toEqual({
      before: { emails: [...ADMINS, DEV].sort(), usernames: ["ubuntu"] },
      after: { emails: [DEV], usernames: ["ubuntu"] },
    });
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });

  it("joining an existing set reuses its app; the emptied set's app goes", async () => {
    const f = threeDroplets();
    await run(f, { account: account() });
    f.ssh["c.example.com"] = ["admins"];
    f.calls = [];
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(gaps).toEqual([]);
    expect(f.calls.some(isInfraAppPost)).toBe(false);
    expect(infraApps(f)).toHaveLength(1);
    expect(opKeys(r.plan).filter((k) => k.includes("infra-app"))).toEqual([expect.stringMatching(/^delete infra-app infra-sync: SSH [0-9a-f]{12}$/)]);
  });

  it("puts back a set app edited by hand, and removes an infrastructure app the tool owns that no set wants", async () => {
    const f = threeDroplets();
    await run(f, { account: account() });
    const app = infraApps(f)[0]!;
    app.policies![0]!.connection_rules = { ssh: { usernames: ["root", "ubuntu"] } };
    f.apps.push({ id: "stray", name: "infra-sync: SSH 000000000000", type: "infrastructure", target_criteria: [{ port: 22, protocol: "SSH", include: { tags: { "ssh-access": ["000000000000"] } } }], policies: [] });
    f.apps.push({ id: "foreign", name: "someone else's SSH", type: "infrastructure", target_criteria: [], policies: [] });
    const r = await run(f, { account: account() });
    expect(r.result.failed).toEqual([]);
    expect(opKeys(r.plan).filter((k) => k.includes("infra-app")).sort()).toEqual([`delete infra-app infra-sync: SSH 000000000000`, `update infra-app ${app.name}`].sort());
    expect(f.apps.find((a) => a.id === app.id)!.policies![0]!.connection_rules).toEqual({ ssh: { usernames: ["ubuntu"] } });
    expect(f.apps.some((a) => a.id === "foreign")).toBe(true);
  });
});

describe("retiring a droplet with its own access set", () => {
  it("deletes its objects and its set's app together, within the one-droplet guard allowance", async () => {
    const f = new FakeCloudflare();
    f.droplets = [droplet(1, "a.example.com", "blr1", "10.0.1.2", ["env-staging", "ci-deploy"]), droplet(2, "b.example.com", "nyc1", "10.0.0.3", ["env-prod"])];
    f.ssh["a.example.com"] = ["devs"];
    await run(f, { account: account() });
    expect(infraApps(f)).toHaveLength(2);
    const aSet = target(f, "a.example.com").tags!["ssh-access"]!;

    f.droplets = f.droplets.slice(1);
    const gaps = watchCoverage(f);
    const r = await run(f, { account: account() });
    expect(r.warnings.join("\n")).not.toMatch(/refusing to delete/);
    expect(gaps).toEqual([]);
    // ssh- DNS, route, ssh- app, target, vpc- DNS, healthcheck app, and the set's app: 7 deletes.
    expect(r.plan.ops.filter((o) => o.action === "delete")).toHaveLength(7);
    expect(infraApps(f).map((a) => a.name)).toEqual([`infra-sync: SSH ${target(f, "b.example.com").tags!["ssh-access"]}`]);
    expect(infraApps(f).some((a) => a.name === `infra-sync: SSH ${aSet}`)).toBe(false);
    expect(changes(await planOnly(f, account()))).toEqual([]);
  });
});
