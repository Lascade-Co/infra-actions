import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { buildDesired, type DesiredState } from "../../src/core/desired.js";
import { WriteNotAllowedError } from "../../src/core/http.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import type { InfraConfig } from "../../src/core/model.js";
import type { ObservedDroplet } from "../../src/core/observed.js";
import type { PlanOp, RunContext } from "../../src/core/plan.js";
import { Secrets } from "../../src/core/secrets.js";
import { MAX_PAGES } from "../../src/droplets/api.js";
import {
  applyDroplets,
  createDropletsProvider,
  createRequest,
  planDroplets,
  toObservedDroplet,
  type DoCreateDropletBody,
} from "../../src/droplets/index.js";
import { EXAMPLE_DIR, exampleFiles, exampleWith } from "../helpers.js";
import { fakeModules } from "../fakes.js";
import { runEngine } from "../../src/engine.js";
import { doDroplet, fakeDo, type FakeDoOptions } from "./fake-do.js";

const TOKEN = "dop_v1_fake-token-value-0000";

function context(fetch: RunContext["fetch"], over: Partial<RunContext> = {}): RunContext & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    mode: "apply",
    account: undefined as unknown as RunContext["account"],
    secrets: new Secrets({ DO_TOKEN: TOKEN }),
    fetch,
    allowWrites: true,
    now: () => new Date("2026-11-19T00:00:00Z"),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
    sleeps,
  };
}

async function exampleConfig(changes?: Record<string, string | null>): Promise<InfraConfig> {
  const { config, diagnostics } = loadInfraFiles(changes ? await exampleWith(changes) : await exampleFiles());
  if (!config) throw new Error(JSON.stringify(diagnostics));
  return config;
}

const obs = (id: number, name: string, over: Partial<ObservedDroplet> = {}): ObservedDroplet => toObservedDroplet(doDroplet(id, name, over as never));

/** The example's existing droplets (shop, db, tools, worker), tagged as their files want. */
function existing(): ObservedDroplet[] {
  return [
    obs(101, "shop.example.com", { tags: ["ci-deploy", "env-prod", "web-public"] }),
    obs(102, "db.example.com", { tags: ["env-prod"] }),
    obs(103, "tools.example.net", { region: { slug: "blr1" }, tags: ["env-internal", "web-staff"] } as never),
    obs(104, "worker.example.com", { tags: ["env-prod"] }),
  ];
}

async function desiredFor(droplets: ObservedDroplet[], changes?: Record<string, string | null>): Promise<DesiredState> {
  return buildDesired(await exampleConfig(changes), droplets);
}

describe("droplets: observe", () => {
  it("reads every page with the token, 200 per page, GET only, and maps each droplet", async () => {
    const all = Array.from({ length: 5 }, (_, i) => doDroplet(200 + i, `d${i}.example.com`));
    const f = fakeDo({ droplets: all, pageSize: 2 });
    const p = createDropletsProvider(context(f.fetch, { allowWrites: false, mode: "check" }));
    const got = await p.observeDroplets();
    expect(got.droplets.map((d) => d.name)).toEqual(all.map((d) => d.name));
    expect(f.calls.map((c) => [c.method, c.path, c.query.page, c.query.per_page])).toEqual([
      ["GET", "/droplets", "1", "200"],
      ["GET", "/droplets", "2", "200"],
      ["GET", "/droplets", "3", "200"],
    ]);
    expect(f.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(got.droplets[0]).toEqual({
      id: 200,
      name: "d0.example.com",
      region: "nyc1",
      privateIpv4: "10.0.0.200",
      publicIpv4: "203.0.113.200",
      tags: ["env-prod"],
      vpcUuid: "00000000-0000-4000-8000-0000000000a1",
      status: "active",
      sizeSlug: "s-1vcpu-1gb",
      imageSlug: "ubuntu-26-04-x64",
      createdAt: "2026-01-01T00:00:00Z",
    });
  });

  it("maps a droplet with no private IP yet, an IPv6 address and an image without slug", () => {
    const d = toObservedDroplet(
      doDroplet(7, "new.example.com", {
        status: "new",
        image: { slug: null },
        networks: { v4: [{ ip_address: "192.0.2.7", type: "public" }], v6: [{ ip_address: "2001:db8::7", type: "public" }] },
      }),
    );
    expect(d.privateIpv4).toBeUndefined();
    expect(d.publicIpv4).toBe("192.0.2.7");
    expect(d.publicIpv6).toBe("2001:db8::7");
    expect(d.imageSlug).toBeUndefined();
    expect(d.status).toBe("new");
  });

  it.each<[string, FakeDoOptions, RegExp]>([
    ["a count that does not match meta.total", { droplets: [doDroplet(1, "a.example.com")], metaTotal: 2 }, /meta.total=2/],
    ["an empty list", { droplets: [] }, /zero droplets/],
    ["a droplet without tags", { droplets: [doDroplet(1, "a.example.com"), doDroplet(2, "b.example.com", { tags: undefined as never })] }, /tag:read/],
    ["no droplet with any tag", { droplets: [doDroplet(1, "a.example.com", { tags: [] })] }, /tag:read/],
    ["a droplet without networks.v4", { droplets: [doDroplet(1, "a.example.com", { networks: {} as never })] }, /networks.v4/],
    ["a failed page", { droplets: [doDroplet(1, "a.example.com")], fail: (c) => (c.path === "/droplets" ? { status: 500 } : undefined) }, /HTTP 500/],
  ])("fails closed on %s", async (_what, opts, msg) => {
    const f = fakeDo(opts);
    await expect(createDropletsProvider(context(f.fetch)).observeDroplets()).rejects.toThrow(msg);
  });

  it("fails when pages keep coming past the page cap", async () => {
    const all = Array.from({ length: MAX_PAGES + 1 }, (_, i) => doDroplet(300 + i, `p${i}.example.com`));
    const f = fakeDo({ droplets: all, pageSize: 1 });
    await expect(createDropletsProvider(context(f.fetch)).observeDroplets()).rejects.toThrow(/more pages/);
    expect(f.calls).toHaveLength(MAX_PAGES);
  });

  it("needs DO_TOKEN only when it reads, and never puts it in errors", async () => {
    const f = fakeDo({ droplets: [doDroplet(1, "a.example.com")], fail: () => ({ status: 401, body: { id: "unauthorized", message: "Unable to authenticate you" } }) });
    const noToken = createDropletsProvider(context(f.fetch, { secrets: new Secrets({}) }));
    await expect(noToken.observeDroplets()).rejects.toThrow("DO_TOKEN is not set");
    const err = (await createDropletsProvider(context(f.fetch)).observeDroplets().catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("digitalocean GET /droplets: HTTP 401 (Unable to authenticate you)");
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("droplets: plan", () => {
  it("creates each droplet with a profile and no droplet, in its env's region, without user_data in the plan", async () => {
    const desired = await desiredFor(existing());
    const plan = planDroplets(desired, { droplets: existing() });
    const creates = plan.ops.filter((o) => o.kind === "droplet");
    expect(creates).toEqual([
      {
        provider: "digitalocean",
        module: "droplets",
        kind: "droplet",
        key: "staging-shop.example.com",
        action: "create",
        before: null,
        after: {
          name: "staging-shop.example.com",
          region: "blr1",
          size: "s-1vcpu-1gb",
          image: "ubuntu-26-04-x64",
          tags: ["ci-deploy", "env-staging", "web-staff"],
          monitoring: true,
          ipv6: false,
          backups: false,
          profile: "ubuntu-6",
        },
        reason: "new droplet from profile ubuntu-6 (s-1vcpu-1gb, ubuntu-26-04-x64) in blr1, the region of env staging",
        droplet: "staging-shop.example.com",
      },
      expect.objectContaining({
        key: "worker-2.example.com",
        after: expect.objectContaining({ region: "nyc1", size: "s-1vcpu-512mb-10gb", tags: ["env-prod"] }),
      }),
    ]);
    const text = JSON.stringify(plan);
    expect(text).not.toContain("user_data");
    expect(text).not.toContain("cloud-config");
    expect(plan.ops.filter((o) => o.kind === "droplet-tags")).toEqual([]);
    expect(plan.unchanged).toBe(4);
    expect(plan.diagnostics).toEqual([]);
  });

  it("the create request carries the profile's cloud-init, the env's region and no VPC (default VPC)", async () => {
    const desired = await desiredFor(existing());
    const d = desired.droplets.find((x) => x.name === "staging-shop.example.com")!;
    const body: DoCreateDropletBody = createRequest(d);
    expect(body.user_data).toBe(desired.profiles["ubuntu-6"]!.userDataText);
    expect(body.user_data.startsWith("#cloud-config")).toBe(true);
    expect(body).not.toHaveProperty("vpc_uuid");
    expect(body).not.toHaveProperty("ssh_keys");
    expect(Object.keys(body).sort()).toEqual(["backups", "image", "ipv6", "monitoring", "name", "region", "size", "tags", "user_data"]);
    expect(() => createRequest(desired.droplets.find((x) => x.name === "shop.example.com")!)).toThrow(/status "create"/);
  });

  it("updates only managed tags; other tags are never in the op", async () => {
    const droplets = existing();
    droplets[0]!.tags = ["production", "env-prod", "ci-deploy", "web-staff", "team-x"]; // wants web-public
    droplets[3]!.tags = ["env-prod", "env-staging", "swarm"]; // a second env tag
    droplets[1]!.tags = ["production"]; // db: missing env-prod
    const plan = planDroplets(await desiredFor(droplets), { droplets });
    const tagOps = plan.ops.filter((o) => o.kind === "droplet-tags");
    expect(tagOps).toEqual([
      expect.objectContaining({
        key: "db.example.com",
        action: "update",
        before: { tags: [] },
        after: { tags: ["env-prod"] },
        reason: "managed tags written from the droplet file: add env-prod",
        ids: { droplet_id: "102" },
      }),
      {
        provider: "digitalocean",
        module: "droplets",
        kind: "droplet-tags",
        key: "shop.example.com",
        action: "update",
        before: { tags: ["ci-deploy", "env-prod", "web-staff"] },
        after: { tags: ["ci-deploy", "env-prod", "web-public"] },
        reason: "managed tags written from the droplet file: add web-public, remove web-staff",
        droplet: "shop.example.com",
        ids: { droplet_id: "101" },
      },
      expect.objectContaining({ key: "worker.example.com", before: { tags: ["env-prod", "env-staging"] }, after: { tags: ["env-prod"] } }),
    ]);
    const text = JSON.stringify(tagOps);
    for (const t of ["production", "team-x", "swarm"]) expect(text).not.toContain(t);
    expect(plan.unchanged).toBe(1);
  });

  it("removes ci-deploy and web tags the file no longer asks for", async () => {
    const droplets = existing();
    droplets[1]!.tags = ["env-prod", "ci-deploy", "web-public"];
    const plan = planDroplets(await desiredFor(droplets), { droplets });
    expect(plan.ops.find((o) => o.key === "db.example.com")).toMatchObject({ before: { tags: ["ci-deploy", "env-prod", "web-public"] }, after: { tags: ["env-prod"] } });
  });

  it("never resizes, rebuilds or deletes: a droplet that drifted from its profile gets an info diagnostic only", async () => {
    const droplets = [...existing(), obs(105, "worker-2.example.com", { region: { slug: "blr1" }, size_slug: "s-2vcpu-2gb", image: { slug: "ubuntu-24-04-x64" }, tags: ["env-prod"] } as never)];
    const plan = planDroplets(await desiredFor(droplets), { droplets });
    expect(plan.ops.filter((o) => o.key === "worker-2.example.com")).toEqual([]);
    expect(plan.ops.every((o) => o.action === "create" || o.action === "update")).toBe(true);
    expect(plan.diagnostics).toEqual([
      {
        level: "info",
        code: "droplet-profile-drift",
        file: "droplets/worker-2.example.com.yaml",
        droplet: "worker-2.example.com",
        message:
          "differs from profile ubuntu-4: size s-2vcpu-2gb (profile: s-1vcpu-512mb-10gb), image ubuntu-24-04-x64 (profile: ubuntu-26-04-x64), region blr1 (env prod: nyc1). The tool is create-only and changes nothing; resize or rebuild by hand if needed",
      },
    ]);
  });

  it("plans nothing for duplicate names or missing droplets (buildDesired reports them)", async () => {
    const droplets = [...existing(), obs(201, "worker.example.com", { tags: [] }), obs(202, "worker-2.example.com", { tags: [] }), obs(203, "worker-2.example.com", { tags: [] })];
    const desired = await desiredFor(droplets.filter((d) => d.name !== "db.example.com"));
    const plan = planDroplets(desired, { droplets });
    expect(plan.ops.map((o) => o.key)).toEqual(["staging-shop.example.com"]);
    expect(desired.diagnostics.map((d) => d.code).sort()).toEqual(["droplet-not-found", "duplicate-droplet", "duplicate-droplet"]);
  });

  it("reports an error instead of an op when a new droplet's profile or region can't be resolved", async () => {
    const desired = await desiredFor(existing());
    const d = desired.droplets.find((x) => x.name === "worker-2.example.com")!;
    delete d.profile;
    const plan = planDroplets(desired, { droplets: existing() });
    expect(plan.ops.map((o) => o.key)).toEqual(["staging-shop.example.com"]);
    expect(plan.diagnostics).toEqual([expect.objectContaining({ level: "error", code: "droplet-create-unresolved", droplet: "worker-2.example.com" })]);
  });

  it("is pure: planning makes no request", async () => {
    const fetch = vi.fn();
    const p = createDropletsProvider(context(fetch as never));
    p.diff(await desiredFor(existing()), { droplets: existing() });
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------- apply ----------

const tagOp = (key: string, id: string, before: string[], after: string[]): PlanOp => ({
  provider: "digitalocean",
  module: "droplets",
  kind: "droplet-tags",
  key,
  action: "update",
  before: { tags: before },
  after: { tags: after },
  reason: "test",
  droplet: key,
  ids: { droplet_id: id },
});

/** A provider observed and planned against the fake, ready to apply. */
async function planned(f: ReturnType<typeof fakeDo>, over: Partial<RunContext> = {}) {
  const ctx = context(f.fetch, over);
  const provider = createDropletsProvider(ctx);
  const observed = await provider.observeDroplets();
  const plan = provider.diff(await desiredFor(observed.droplets), observed);
  f.calls.length = 0;
  return { ctx, provider, observed, plan };
}

const existingDo = () => [
  doDroplet(101, "shop.example.com", { tags: ["ci-deploy", "env-prod", "web-public"] }),
  doDroplet(102, "db.example.com", { tags: ["env-prod"] }),
  doDroplet(103, "tools.example.net", { region: { slug: "blr1" }, tags: ["env-internal", "web-staff"] }),
  doDroplet(104, "worker.example.com", { tags: ["env-prod", "production"] }),
];

describe("droplets: apply", () => {
  it("checks names, creates each new droplet once with its profile's cloud-init, waits for its IPs, then reports it applied", async () => {
    const f = fakeDo({ droplets: existingDo(), pollsUntilActive: 3 });
    const { ctx, provider, observed, plan } = await planned(f);
    const res = await provider.apply(plan.ops, observed);

    expect(res.failed).toEqual([]);
    expect(res.skipped).toEqual([]);
    expect(res.applied.map((o) => [o.key, o.ids?.droplet_id])).toEqual([
      ["staging-shop.example.com", "9000"],
      ["worker-2.example.com", "9001"],
    ]);
    const writes = f.writes();
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /droplets", "POST /droplets"]);
    expect(writes[0]!.body).toEqual({
      name: "staging-shop.example.com",
      region: "blr1",
      size: "s-1vcpu-1gb",
      image: "ubuntu-26-04-x64",
      user_data: (await exampleConfig()).profiles["ubuntu-6"]!.userDataText,
      tags: ["ci-deploy", "env-staging", "web-staff"],
      monitoring: true,
      ipv6: false,
      backups: false,
    });
    // the name check comes before any create
    expect(f.calls[0]).toMatchObject({ method: "GET", path: "/droplets" });
    expect(ctx.sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(ctx.sleeps).toHaveLength(3);
    expect(f.droplets.filter((d) => d.name === "worker-2.example.com")).toHaveLength(1);
    expect(f.droplets.find((d) => d.id === 9000)!.status).toBe("active");
  });

  it("does not create a droplet whose name appeared since the plan, and skips everything after", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const { provider, observed, plan } = await planned(f);
    f.droplets.push(doDroplet(150, "staging-shop.example.com", { tags: [] }));
    const res = await provider.apply(plan.ops, observed);
    expect(f.writes()).toEqual([]);
    expect(res.failed).toEqual([{ op: expect.objectContaining({ key: "staging-shop.example.com" }), error: "a droplet named staging-shop.example.com already exists; not creating another" }]);
    expect(res.skipped.map((s) => s.op.key)).toEqual(["worker-2.example.com"]);
    expect(res.applied).toEqual([]);
  });

  it("never retries a failed create, stops, and keeps the droplets already created as applied", async () => {
    let posts = 0;
    const f = fakeDo({
      droplets: existingDo(),
      fail: (c) => (c.method === "POST" && c.path === "/droplets" && ++posts === 2 ? { status: 500, body: { id: "server_error", message: "Server was unable to give you a response." } } : undefined),
    });
    const { provider, observed, plan } = await planned(f);
    const ops = [...plan.ops, tagOp("db.example.com", "102", ["env-prod"], ["ci-deploy", "env-prod"])];
    const res = await provider.apply(ops, observed);
    expect(f.writes().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /droplets", "POST /droplets"]);
    expect(res.applied.map((o) => [o.key, o.ids?.droplet_id])).toEqual([["staging-shop.example.com", "9000"]]);
    expect(res.failed).toEqual([
      { op: expect.objectContaining({ key: "worker-2.example.com" }), error: "create failed (not retried): digitalocean POST /droplets: HTTP 500 (Server was unable to give you a response.)" },
    ]);
    expect(res.skipped.map((s) => s.op.key)).toEqual(["db.example.com"]);
  });

  it("times out after the bounded wait and reports the droplet as failed", async () => {
    const f = fakeDo({ droplets: existingDo(), pollsUntilActive: 1000 });
    const { ctx, provider, observed, plan } = await planned(f);
    const creates = plan.ops.filter((o) => o.kind === "droplet");
    const res = await provider.apply([...creates, tagOp("db.example.com", "102", ["env-prod"], ["ci-deploy", "env-prod"])], observed);
    expect(ctx.sleeps).toHaveLength(60);
    expect(ctx.sleeps.reduce((a, b) => a + b, 0)).toBe(300_000);
    expect(res.applied).toEqual([]);
    expect(res.failed.map((x) => x.error)).toEqual([
      "created as id 9000 but not active with public and private IPv4 after 300s (status new, private IPv4 no, public IPv4 no)",
      "created as id 9001 but not active with public and private IPv4 after 300s (status new, private IPv4 no, public IPv4 no)",
    ]);
    expect(res.skipped.map((s) => s.op.key)).toEqual(["db.example.com"]);
    expect(f.writes().filter((c) => c.path.startsWith("/tags"))).toEqual([]);
  });

  it("keeps polling through a failed read while the wait lasts", async () => {
    let fails = 1;
    const f = fakeDo({ droplets: existingDo(), fail: (c) => (/^\/droplets\/\d+$/.test(c.path) && fails-- > 0 ? { status: 503 } : undefined) });
    const { provider, observed, plan } = await planned(f);
    const res = await provider.apply(plan.ops.slice(0, 1), observed);
    expect(res.failed).toEqual([]);
    expect(res.applied.map((o) => o.key)).toEqual(["staging-shop.example.com"]);
  });

  it("adds missing managed tags (creating the tag if needed) before removing others, through the tags API", async () => {
    const f = fakeDo({ droplets: existingDo(), tags: ["env-prod", "env-staging", "env-internal", "web-staff", "web-public", "ci-deploy", "production"] });
    f.droplets[0]!.tags = ["env-prod", "ci-deploy", "web-staff", "production"];
    f.droplets[1]!.tags = ["env-prod", "env-staging"];
    const { provider, observed, plan } = await planned(f);
    const res = await provider.apply(plan.ops.filter((o) => o.kind === "droplet-tags"), observed);
    expect(res.failed).toEqual([]);
    expect(res.applied.map((o) => o.key)).toEqual(["db.example.com", "shop.example.com"]);
    expect(f.writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["DELETE", "/tags/env-staging/resources", { resources: [{ resource_id: "102", resource_type: "droplet" }] }],
      ["POST", "/tags/web-public/resources", { resources: [{ resource_id: "101", resource_type: "droplet" }] }],
      ["DELETE", "/tags/web-staff/resources", { resources: [{ resource_id: "101", resource_type: "droplet" }] }],
    ]);
    expect(f.droplets[0]!.tags).toEqual(["env-prod", "ci-deploy", "production", "web-public"]);
    expect(f.droplets[1]!.tags).toEqual(["env-prod"]);
  });

  it("creates a tag that does not exist yet, then tags the droplet", async () => {
    const f = fakeDo({ droplets: existingDo(), tags: ["env-prod"] });
    const res = await applyDroplets(context(f.fetch), [tagOp("db.example.com", "102", ["env-prod"], ["ci-deploy", "env-prod"])]);
    expect(res.applied).toHaveLength(1);
    expect(f.writes().map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/tags", { name: "ci-deploy" }],
      ["POST", "/tags/ci-deploy/resources", { resources: [{ resource_id: "102", resource_type: "droplet" }] }],
    ]);
  });

  it("never touches a tag outside the managed list, even if an op names one", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const res = await applyDroplets(context(f.fetch), [tagOp("worker.example.com", "104", ["env-prod", "production"], ["env-prod", "team-x"])]);
    expect(res.applied).toHaveLength(1);
    expect(f.writes()).toEqual([]);
    expect(f.droplets[3]!.tags).toEqual(["env-prod", "production"]);
  });

  it("stops at the first failed tag change and says what was already done", async () => {
    const f = fakeDo({
      droplets: existingDo(),
      tags: ["env-prod", "ci-deploy", "web-public", "web-staff"],
      fail: (c) => (c.method === "DELETE" ? { status: 403, body: { id: "forbidden", message: "You do not have access for the attempted action." } } : undefined),
    });
    const ops = [tagOp("db.example.com", "102", ["env-prod", "web-staff"], ["ci-deploy", "env-prod"]), tagOp("shop.example.com", "101", [], ["env-prod"])];
    const res = await applyDroplets(context(f.fetch), ops);
    expect(res.failed).toEqual([
      {
        op: ops[0],
        error: "digitalocean DELETE /tags/web-staff/resources: HTTP 403 (You do not have access for the attempted action.) (already done: added ci-deploy)",
      },
    ]);
    expect(res.skipped).toEqual([{ op: ops[1], reason: "not applied: an earlier droplets op failed" }]);
  });

  it("refuses deletes, resizes and ops of other modules before sending anything", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const del: PlanOp = { provider: "digitalocean", module: "droplets", kind: "droplet", key: "db.example.com", action: "delete", before: {}, after: null, reason: "x" };
    const resize: PlanOp = { ...del, action: "update", after: { size: "s-2vcpu-2gb" } };
    const foreign: PlanOp = { ...tagOp("db.example.com", "102", [], ["env-prod"]), module: "firewall" };
    const ok = tagOp("db.example.com", "102", ["env-prod"], ["ci-deploy", "env-prod"]);
    const res = await applyDroplets(context(f.fetch), [ok, del, resize, foreign]);
    expect(f.calls).toEqual([]);
    expect(res.failed.map((x) => x.error)).toEqual([
      "refused: create-only, the tool never does delete on droplet",
      "refused: create-only, the tool never does update on droplet",
      "refused: not a droplets op (firewall)",
    ]);
    expect(res.skipped.map((s) => s.op)).toEqual([ok]);
  });

  it("refuses a create with no create request from the current plan (user_data never travels in ops)", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const { plan } = await planned(f);
    const res = await applyDroplets(context(f.fetch), plan.ops, {});
    expect(f.calls).toEqual([]);
    expect(res.failed).toHaveLength(2);
    expect(res.failed[0]!.error).toBe("refused: no create request for this droplet in the current plan");
  });

  it("skips report ops (frozen droplets)", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const op = { ...tagOp("db.example.com", "102", [], ["env-prod"]), action: "report" as const };
    const res = await applyDroplets(context(f.fetch), [op]);
    expect(res).toEqual({ module: "droplets", applied: [], failed: [], skipped: [{ op, reason: "report only" }] });
    expect(f.calls).toEqual([]);
  });

  it("a read-only run can't create: the client refuses the POST", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const { provider, observed, plan } = await planned(f, { allowWrites: false, mode: "check" });
    const res = await provider.apply(plan.ops, observed);
    expect(f.writes()).toEqual([]);
    expect(res.failed[0]!.error).toContain(new WriteNotAllowedError("POST", "/droplets").message);
  });

  it("the provider observes, plans and applies end to end; a second plan is then empty", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const { provider, observed, plan } = await planned(f);
    expect(plan.ops.map((o) => `${o.kind} ${o.action} ${o.key}`)).toEqual([
      "droplet create staging-shop.example.com",
      "droplet create worker-2.example.com",
    ]);
    const res = await provider.apply(plan.ops, observed);
    expect(res.failed).toEqual([]);
    const again = await provider.observeDroplets();
    const second = provider.diff(await desiredFor(again.droplets), again);
    expect(second.ops).toEqual([]);
    expect(second.unchanged).toBe(6);
    expect(again.droplets.find((d) => d.name === "worker.example.com")!.tags).toEqual(["env-prod", "production"]);
  });
});

describe("droplets: in the engine", () => {
  it("apply creates the new droplets, waits for them, and the re-plan sees them with IPs", async () => {
    const f = fakeDo({ droplets: existingDo() });
    const fakes = fakeModules({ droplets: [] });
    const report = await runEngine({
      mode: "apply",
      infraDir: EXAMPLE_DIR,
      env: { DO_TOKEN: TOKEN },
      fetch: f.fetch,
      now: () => new Date("2026-11-19T00:00:00Z"),
      sleep: async () => {},
      modules: (ctx) => ({ ...fakes.modules(ctx), droplets: createDropletsProvider(ctx) }),
    });
    const applied = report.applied.find((a) => a.module === "droplets")!;
    expect(applied.failed).toEqual([]);
    expect(applied.applied.map((o) => o.key)).toEqual(["staging-shop.example.com", "worker-2.example.com"]);
    expect(f.writes().map((c) => `${c.method} ${c.path}`)).toEqual(["POST /droplets", "POST /droplets"]);
    // after the re-plan the droplets plan is empty and the new droplets have their private IPs
    expect(report.plans.find((p) => p.module === "droplets")!.ops).toEqual([]);
    const cf = report.applied.find((a) => a.module === "cloudflare")!;
    expect(cf.applied.find((o) => o.droplet === "worker-2.example.com")!.after).toEqual({ content: "10.0.0.1" });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain("cloud-config");
  });
});

describe("droplets: the example profiles", () => {
  it("ubuntu-4 and ubuntu-6 pin the documented sizes and image", async () => {
    const { profiles } = await exampleConfig();
    expect(Object.fromEntries(Object.values(profiles).map((p) => [p.name, [p.size, p.image]]))).toEqual({
      "ubuntu-4": ["s-1vcpu-512mb-10gb", "ubuntu-26-04-x64"],
      "ubuntu-6": ["s-1vcpu-1gb", "ubuntu-26-04-x64"],
    });
  });

  it("the cloud-init creates ubuntu with passwordless sudo, trusts the CA, forbids root login, reloads sshd only if valid", async () => {
    const text = (await exampleConfig()).profiles["ubuntu-6"]!.userDataText;
    const ci = parse(text) as {
      users: Array<Record<string, unknown>>;
      write_files: Array<{ path: string; content: string }>;
      runcmd: unknown[];
    };
    expect(ci.users).toEqual([expect.objectContaining({ name: "ubuntu", sudo: "ALL=(ALL) NOPASSWD:ALL", lock_passwd: true })]);
    const file = (p: string) => ci.write_files.find((f) => f.path === p)?.content ?? "";
    expect(file("/etc/ssh/sshd_config.d/90-cloudflare-ca.conf")).toContain("TrustedUserCAKeys /etc/ssh/cloudflare_ca.pub");
    expect(file("/etc/ssh/cloudflare_ca.pub")).toMatch(/^ecdsa-sha2-nistp256 AAAAEXAMPLEPLACEHOLDER/);
    // the first file sshd reads in sshd_config.d sets PermitRootLogin, so nothing later can turn it back on
    const dropIns = ci.write_files.filter((f) => f.path.startsWith("/etc/ssh/sshd_config.d/")).sort((a, b) => a.path.localeCompare(b.path));
    expect(dropIns[0]!.content.trim()).toBe("PermitRootLogin no");
    expect(JSON.stringify(ci.runcmd)).toContain("sshd -t && (systemctl reload ssh");
    expect(JSON.stringify(ci)).not.toMatch(/ssh_authorized_keys|ssh-rsa|ssh-ed25519|docker|packages/i);
  });
});
