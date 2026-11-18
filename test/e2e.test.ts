// End to end: the example checkout through the real loader, the real registry and every real
// module, against in-memory fakes of DigitalOcean, Cloudflare, OneUptime and GitHub behind one
// fetch that routes by host (anything else throws). Apply creates the two new droplets and
// everything that hangs off them; a second apply finds nothing to change and writes nothing.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { loadInfraFiles } from "../src/core/loader.js";
import { isChange } from "../src/core/plan.js";
import { reportPassed } from "../src/core/report.js";
import { runEngine } from "../src/engine.js";
import { CF_TOKEN, FakeCloudflare } from "./cloudflare/fake.js";
import { doDroplet, fakeDo } from "./droplets/fake-do.js";
import { EXAMPLE_DIR, exampleFiles } from "./helpers.js";
import { fakeOneUptime, SECRETS_ENV as OU_SECRETS } from "./oneuptime/fake-oneuptime.js";

const GH_TOKEN = "gh-test-token-value";
const ENV = { CF_API_TOKEN: CF_TOKEN, DO_TOKEN: "do-test-token-value", INFRA_GH_TOKEN: GH_TOKEN, ...OU_SECRETS };

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A stateful GitHub: one branch, git trees/commits/refs and the contents API, as sshconfig uses them. */
function fakeGitHub(repo: string, branch: string) {
  let ref: string | undefined;
  const trees = new Map<string, Record<string, string>>();
  const commits = new Map<string, { tree: string }>();
  const writes: string[] = [];
  let n = 0;
  const sha = () => (++n).toString(16).padStart(40, "0");
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${GH_TOKEN}`) return json(401, { message: "Bad credentials" });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = decodeURIComponent(url.pathname);
    const base = `/repos/${repo}`;
    if (method !== "GET") writes.push(`${method} ${p}`);
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = new RegExp(`^${base}/contents/(.+)$`).exec(p))) {
      const files = ref && url.searchParams.get("ref") === branch ? trees.get(commits.get(ref)!.tree)! : undefined;
      const text = files?.[m[1]!];
      return text === undefined ? json(404, { message: "Not Found" }) : json(200, { content: Buffer.from(text).toString("base64"), encoding: "base64", sha: `blob-${m[1]}` });
    }
    if (method === "GET" && p === `${base}/git/ref/heads/${branch}`) return ref ? json(200, { object: { sha: ref } }) : json(404, { message: "Not Found" });
    if (method === "GET" && (m = new RegExp(`^${base}/git/commits/(\\w+)$`).exec(p))) return json(200, { tree: { sha: commits.get(m[1]!)!.tree } });
    if (method === "GET" && (m = new RegExp(`^${base}/git/trees/(\\w+)$`).exec(p))) {
      return json(200, { sha: m[1], tree: Object.keys(trees.get(m[1]!)!).map((path) => ({ path, type: "blob" })) });
    }
    if (method === "POST" && p === `${base}/git/trees`) {
      const s = sha();
      trees.set(s, Object.fromEntries((body.tree as Array<{ path: string; content: string }>).map((t) => [t.path, t.content])));
      return json(201, { sha: s });
    }
    if (method === "POST" && p === `${base}/git/commits`) {
      const s = sha();
      commits.set(s, { tree: body.tree });
      return json(201, { sha: s });
    }
    if ((method === "PATCH" && p === `${base}/git/refs/heads/${branch}`) || (method === "POST" && p === `${base}/git/refs`)) {
      ref = body.sha;
      return json(200, { object: { sha: ref } });
    }
    return json(404, { message: `fake has no route ${method} ${p}` });
  };
  return { fetch, writes, file: (name: string) => (ref ? trees.get(commits.get(ref)!.tree)![name] : undefined) };
}

async function world() {
  const config = loadInfraFiles(await exampleFiles()).config!;
  const account = config.account;
  const cf = new FakeCloudflare();
  cf.zones = account.cloudflare.zones.map((name) => ({ id: `zone-${name.split(".").pop()}`, name }));
  cf.dns = Object.fromEntries(cf.zones.map((z) => [z.id, []]));
  cf.tunnels = {};
  for (const t of Object.values(account.cloudflare.tunnels)) cf.tunnels[t] = { tunnel_id: t, source: "cloudflare", version: 1, config: { ingress: [{ service: "http_status:404" }] } };
  const doApi = fakeDo({
    droplets: [
      doDroplet(11, "db.example.com"),
      doDroplet(12, "shop.example.com"),
      doDroplet(13, "tools.example.net", { region: { slug: "blr1" }, tags: ["env-internal"] }),
      doDroplet(14, "worker.example.com"),
    ],
  });
  const ou = fakeOneUptime();
  const gh = fakeGitHub(account.github.infra_repo, account.github.ssh_config_branch);
  const other: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    switch (url.origin) {
      case "https://api.digitalocean.com":
        // No firewalls in the fake account: the firewall plan reports what the files ask for.
        if (url.pathname === "/v2/firewalls") return json(200, { firewalls: [], links: {}, meta: { total: 0 } });
        return doApi.fetch(input, init);
      case "https://api.cloudflare.com":
        return cf.fetch(input, init);
      case account.oneuptime!.url:
        return ou.fetch(input, init);
      case "https://api.github.com":
        return gh.fetch(input, init);
      default:
        other.push(url.origin);
        throw new Error(`unexpected host ${url.origin}`);
    }
  };
  const writes = () => ({
    digitalocean: doApi.writes().length,
    cloudflare: cf.writes().length,
    oneuptime: ou.calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/get-list")).length,
    github: gh.writes.length,
  });
  return { cf, doApi, ou, gh, fetch, writes, other };
}

const run = (w: Awaited<ReturnType<typeof world>>, mode: "check" | "apply") =>
  runEngine({ mode, infraDir: EXAMPLE_DIR, env: ENV, fetch: w.fetch, now: () => new Date("2026-11-19T00:00:00Z"), sleep: async () => {} });

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("end to end: the example checkout against fakes of every API", () => {
  it("applies everything once, then a second apply plans and writes nothing", async () => {
    const w = await world();

    const first = await run(w, "apply");
    expect(first.stages.filter((s) => s.status === "failed" || s.status === "not-implemented")).toEqual([]);
    expect(first.applied.flatMap((a) => a.failed)).toEqual([]);
    expect(reportPassed(first)).toBe(true);
    expect(first.applied.map((a) => a.module)).toEqual(["droplets", "cloudflare", "firewall", "oneuptime", "sshconfig"]);
    // The two new droplets, in their environment's region, with a private IP for the rest.
    const created = w.doApi.droplets.filter((d) => d.id >= 9000);
    expect(created.map((d) => [d.name, d.region?.slug])).toEqual([
      ["staging-shop.example.com", "blr1"],
      ["worker-2.example.com", "nyc1"],
    ]);
    expect(created.every((d) => d.networks?.v4?.some((n) => n.type === "private"))).toBe(true);
    expect(w.ou.monitors.length).toBeGreaterThan(0);
    expect(w.gh.file("ssh_config")).toContain("Host worker-2.example.com");
    const firstWrites = w.writes();
    expect(Object.values(firstWrites).every((n) => n > 0)).toBe(true);

    const second = await run(w, "apply");
    expect(reportPassed(second)).toBe(true);
    expect(second.plans.flatMap((p) => p.ops).filter(isChange)).toEqual([]);
    // Stronger than trusting the plan: no API saw a write.
    expect(w.writes()).toEqual(firstWrites);
    // What is left is report-only: the frozen droplet, the firewall plan and routes not built.
    const reports = second.plans.flatMap((p) => p.ops).filter((o) => o.action === "report");
    expect(reports.length).toBeGreaterThan(0);
    for (const o of reports) {
      const why = o.module === "firewall" ? "firewall" : o.reason.startsWith("frozen droplet") ? "frozen" : o.key.startsWith("(not built)") ? "not built" : `unexpected: ${o.module} ${o.key}`;
      expect(why).not.toMatch(/^unexpected/);
    }
    expect(w.other).toEqual([]);
  });

  it("check through the CLI writes the PR comment with the grouped sections", async () => {
    const w = await world();
    tmp = await mkdtemp(join(tmpdir(), "infra-e2e-"));
    const out = join(tmp, "comment.md");
    const stdout: string[] = [];
    const code = await main(["check", EXAMPLE_DIR, "--out", out], {
      stdout: (l) => stdout.push(l),
      stderr: () => {},
      env: ENV,
      fetch: w.fetch,
      now: () => new Date("2026-11-19T00:00:00Z"),
      sleep: async () => {},
    });
    expect(code).toBe(0);
    expect(stdout[0]).toMatch(/^infra check: PASS \| droplet files 6 \|/);
    const md = await readFile(out, "utf8");
    expect(md.split("\n")[0]).toBe("<!-- infra-actions:plan -->");
    // B1's real warning code lands under its own heading.
    expect(md).toContain("#### Tunnel routes not built: add them by hand (1)");
    expect(md).toContain("worker-2-metrics.example.com");
    // The firewall report: one collapsed block per droplet.
    expect(md).toMatch(/<details><summary>Firewall rules: report only, not enforced until Phase 5 \(\d+ on \d+ droplet\(s\)\)<\/summary>/);
    expect(md).toMatch(/<details><summary>`db\.example\.com`: \d+ to allow<\/summary>/);
    expect(w.writes()).toEqual({ digitalocean: 0, cloudflare: 0, oneuptime: 0, github: 0 });
  });
});
