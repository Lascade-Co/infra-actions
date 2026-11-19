// In-memory fake of the Cloudflare endpoints the cloudflare module uses (a mocked fetch: no request
// ever leaves the process), plus a harness that turns a Worker-style test setup (droplets with
// tags + per-site config) into droplet files and runs observe -> plan -> apply.
//
// Everything here is fake: example.com/.net/.org, RFC 5737 and 10.0.x.x addresses, placeholder ids.

import { buildDesired, type DesiredState } from "../../src/core/desired.js";
import { dropletFromData } from "../../src/core/loader.js";
import type { AccountConfig, AllowTunnel, DropletFile, EnvName, InfraConfig } from "../../src/core/model.js";
import { convertLegacy } from "../../src/export/convert.js";
import { parsePort, parseWho } from "../../src/core/values.js";
import type { ObservedDroplet } from "../../src/core/observed.js";
import { isChange, type ApplyResult, type ModulePlan, type PlanOp, type RunContext } from "../../src/core/plan.js";
import { Secrets } from "../../src/core/secrets.js";
import { freezeOps } from "../../src/engine.js";
import { applyCloudflare, observeCloudflare, planCloudflare } from "../../src/cloudflare/index.js";
import type { AccessApp, CloudflareObserved, DnsRecord, InfraTarget, TunnelConfiguration, WafRuleset, Zone } from "../../src/cloudflare/types.js";

export const ACCOUNT = "0123456789abcdef0123456789abcdef";
export const T_NYC1 = "00000000-0000-4000-8000-0000000000a1";
export const T_BLR1 = "00000000-0000-4000-8000-0000000000a2";
export const T_SFO3 = "00000000-0000-4000-8000-0000000000a3";
export const STAGING_TOKEN = "00000000-0000-4000-8000-000000000102";
export const ETL_TOKEN = "00000000-0000-4000-8000-000000000104";
export const UPTIME_TOKEN = "00000000-0000-4000-8000-000000000105";
export const STAFF_POLICY = "00000000-0000-4000-8000-000000000010";
export const ADMINS = ["admin@example.com", "ops@example.com"];
export const CF_TOKEN = "cf-test-token-value";

export const Z_COM = "zone-com";
export const Z_NET = "zone-net";
export const Z_ORG = "zone-org";

export function testAccount(over: Partial<AccountConfig["cloudflare"]> = {}): AccountConfig {
  return {
    cloudflare: {
      account_id: ACCOUNT,
      team_domain: "https://example.cloudflareaccess.com",
      zones: ["example.com", "example.net", "example.org"],
      tunnels: { nyc1: T_NYC1, blr1: T_BLR1, sfo3: T_SFO3 },
      staff_policy_id: STAFF_POLICY,
      service_tokens: { "ci-staging": STAGING_TOKEN, etl: ETL_TOKEN, uptime: UPTIME_TOKEN },
      guards: { max_deletes: 20, max_delete_fraction: 0.3 },
      ...over,
    },
    digitalocean: { regions: { prod: "nyc1", staging: "blr1", internal: "blr1" } },
    github: { infra_repo: "example-org/infra", ssh_config_branch: "ssh-config", ssh_config_file: "ssh_config" },
    ssh_config: { title: "Example Co droplets", user: "ubuntu" },
    email_domain: "example.com",
    groups: { admins: [...ADMINS] },
  };
}

export interface Call {
  method: string;
  url: string;
  path: string;
  body?: any;
}

type Failer = (c: Call) => { status: number; body?: unknown } | undefined;

let idSeq = 0;
const newId = (p: string) => `${p}-${(++idSeq).toString().padStart(4, "0")}`;

/** A DigitalOcean droplet as a Worker test described it: name, region, private IP, tags. */
export interface FakeDroplet {
  id: number;
  name: string;
  region: string;
  privateIp: string | null;
  publicIp: string;
  tags: string[];
}

export function droplet(id: number, name: string, region: string, ip: string | null, tags: string[] = []): FakeDroplet {
  return { id, name, region, privateIp: ip, publicIp: `203.0.113.${id % 250}`, tags };
}

/** A web-config.json exception, as the Worker reads it (plus service_tokens, which the tool added). */
export interface WebException {
  path: string;
  allow: "everyone" | { ips?: string[]; service_tokens?: string[] };
}

/** The Worker's web-config.json entry for one site. */
export interface SiteCfg {
  hostnames?: string[];
  origin?: string;
  protected_paths?: string[];
  exceptions?: WebException[];
  health_path?: string;
  health_accept_app_404?: boolean;
}

export class FakeCloudflare {
  zones: Zone[] = [
    { id: Z_COM, name: "example.com" },
    { id: Z_NET, name: "example.net" },
    { id: Z_ORG, name: "example.org" },
  ];
  targets: InfraTarget[] = [];
  apps: AccessApp[] = [];
  tunnels: Record<string, TunnelConfiguration> = {};
  dns: Record<string, DnsRecord[]> = {};
  /** By zone id: the http_request_firewall_custom entry point ruleset; absent = none yet (GET 404). */
  waf: Record<string, WafRuleset> = {};
  calls: Call[] = [];
  failers: Failer[] = [];

  // The test's "DigitalOcean" and droplet files.
  droplets: FakeDroplet[] = [];
  /** web-config.json equivalent: per droplet name. */
  sites: Record<string, SiteCfg> = {};
  /** allow.tunnel entries per droplet name (written as in a droplet file). */
  routes: Record<string, Array<{ route: string; port: string; who: string[] }>> = {};
  /** Droplets that exist but have no droplet file. */
  noFile = new Set<string>();
  /** Droplet files marked frozen. */
  frozen = new Set<string>();
  /** A droplet file's ssh list, by droplet name; default ["admins"] (= ADMINS, the Worker's admins). */
  ssh: Record<string, string[]> = {};
  /** A droplet file's web section as written (web.access ...), in place of the one its tags and f.sites give. */
  web: Record<string, Record<string, unknown>> = {};
  /** The Worker's CI_SERVICE_TOKEN_IDS, by name: what a ci-deploy tag becomes in a droplet file's ssh list. */
  ciTokens: Partial<Record<EnvName, string[]>> = { staging: ["ci-staging"] };
  /** Droplet files with a profile for a droplet that does not exist yet (status create): name -> env. */
  toCreate: Record<string, { env: "prod" | "staging" | "internal"; tags?: string[] }> = {};

  // Account-level (reusable) Access policies. An app body may attach one as {id, precedence};
  // like the real API, the app is then returned with the policy expanded.
  reusablePolicies: Record<string, any> = {
    [STAFF_POLICY]: { id: STAFF_POLICY, name: "staff", decision: "allow", include: [{ email_domain: { domain: "example.com" } }], reusable: true },
  };

  constructor() {
    for (const t of [T_NYC1, T_BLR1, T_SFO3]) {
      this.tunnels[t] = { tunnel_id: t, source: "cloudflare", version: 1, config: { ingress: [{ service: "http_status:404" }] } };
    }
    for (const z of this.zones) this.dns[z.id] = [];
  }

  private appPolicies(ps: any[] | undefined, keepIds: boolean): any[] {
    return (ps ?? []).map((x: any) => {
      const shared = x.id && !("decision" in x) ? this.reusablePolicies[x.id] : undefined;
      if (shared) return { ...structuredClone(shared), precedence: x.precedence };
      return { id: keepIds ? (x.id ?? newId("pol")) : newId("pol"), ...x };
    });
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  failWhen(f: Failer) {
    this.failers.push(f);
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { method, url: input, path: u.pathname, body };
    this.calls.push(call);
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== `Bearer ${CF_TOKEN}`) return json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);
    for (const f of this.failers) {
      const r = f(call);
      if (r) return json(r.body ?? { success: false, errors: [{ code: 10000, message: "injected failure" }] }, r.status);
    }
    if (u.hostname === "api.cloudflare.com") return this.cfRoute(method, u, body);
    return json({ error: `unexpected host ${u.hostname}` }, 599);
  };

  private cfRoute(method: string, u: URL, body: any): Response {
    const p = u.pathname.replace(/^\/client\/v4/, "");
    const acct = `/accounts/${ACCOUNT}`;
    let m: RegExpMatchArray | null;
    const ok = (result: unknown, info?: unknown) => json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
    const list = (arr: unknown[]) => ok(structuredClone(arr), { page: 1, per_page: arr.length, count: arr.length, total_count: arr.length, total_pages: 1 });

    if (method === "GET" && p === "/zones") return list(this.zones);

    if (p === `${acct}/infrastructure/targets`) {
      if (method === "GET") return list(this.targets);
      if (method === "POST") {
        const t = { id: newId("target"), ...body };
        this.targets.push(t);
        return ok(t);
      }
    }
    if ((m = p.match(new RegExp(`^${acct}/infrastructure/targets/([^/]+)$`)))) {
      const i = this.targets.findIndex((t) => t.id === m![1]);
      if (i < 0) return json({ success: false, errors: [{ code: 404, message: "not found" }] }, 404);
      if (method === "PUT") {
        this.targets[i] = { id: m[1]!, ...body };
        return ok(this.targets[i]);
      }
      if (method === "DELETE") {
        this.targets.splice(i, 1);
        return new Response(null, { status: 204 });
      }
    }

    if (p === `${acct}/access/apps`) {
      if (method === "GET") return list(this.apps);
      if (method === "POST") {
        const a = { id: newId("app"), ...body, policies: this.appPolicies(body.policies, false) };
        this.apps.push(a);
        return ok(a);
      }
    }
    if ((m = p.match(new RegExp(`^${acct}/access/apps/([^/]+)$`)))) {
      const i = this.apps.findIndex((a) => a.id === m![1]);
      if (i < 0) return json({ success: false, errors: [{ code: 404, message: "not found" }] }, 404);
      if (method === "PUT") {
        this.apps[i] = { id: m[1]!, ...body, policies: this.appPolicies(body.policies, true) };
        return ok(this.apps[i]);
      }
      if (method === "DELETE") {
        this.apps.splice(i, 1);
        return ok({ id: m[1] });
      }
    }

    if ((m = p.match(new RegExp(`^${acct}/cfd_tunnel/([^/]+)/configurations$`)))) {
      const t = this.tunnels[m[1]!];
      if (!t) return json({ success: false, errors: [{ code: 404, message: "tunnel not found" }] }, 404);
      if (method === "GET") return ok(structuredClone(t));
      if (method === "PUT") {
        t.config = structuredClone(body.config);
        t.version = (t.version ?? 0) + 1;
        return ok(structuredClone(t));
      }
    }

    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records$/))) {
      const zid = m[1]!;
      const recs = this.dns[zid] ?? (this.dns[zid] = []);
      if (method === "GET") {
        const prefix = u.searchParams.get("name.startswith");
        const exact = u.searchParams.get("name");
        return list(recs.filter((r) => (!prefix || r.name.startsWith(prefix)) && (!exact || r.name === exact)));
      }
      if (method === "POST") {
        const r = { id: newId("dns"), ...body };
        recs.push(r);
        return ok(r);
      }
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/dns_records\/([^/]+)$/))) {
      const recs = this.dns[m[1]!] ?? [];
      const i = recs.findIndex((r) => r.id === m![2]);
      if (i < 0) return json({ success: false, errors: [{ code: 81044, message: "record not found" }] }, 404);
      if (method === "GET") return ok(structuredClone(recs[i]));
      if (method === "PATCH") {
        recs[i] = { ...recs[i]!, ...body };
        return ok(recs[i]);
      }
      if (method === "DELETE") {
        recs.splice(i, 1);
        return ok({ id: m[2] });
      }
    }
    // WAF custom rules: the entry point ruleset of http_request_firewall_custom, and its rules one by one.
    if ((m = p.match(/^\/zones\/([^/]+)\/rulesets\/phases\/http_request_firewall_custom\/entrypoint$/)) && method === "GET") {
      const rs = this.waf[m[1]!];
      return rs ? ok(structuredClone(rs)) : json({ success: false, errors: [{ code: 10003, message: "could not find entrypoint ruleset in the http_request_firewall_custom phase" }] }, 404);
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/rulesets$/)) && method === "POST") {
      const zid = m[1]!;
      if (this.waf[zid] || body?.kind !== "zone" || body?.phase !== "http_request_firewall_custom") return json({ success: false, errors: [{ code: 20217, message: "a ruleset already exists for this phase" }] }, 400);
      this.waf[zid] = { id: newId("ruleset"), rules: (body.rules ?? []).map((r: any) => ({ id: newId("rule"), ...r })) };
      return ok(structuredClone(this.waf[zid]));
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules$/)) && method === "POST") {
      const rs = this.waf[m[1]!];
      if (!rs || rs.id !== m[2]) return json({ success: false, errors: [{ code: 404, message: "ruleset not found" }] }, 404);
      const { position, ...rule } = body;
      const rules = rs.rules ?? (rs.rules = []);
      // As documented: the end by default; before "" = first, after "" = last, or a 1-based index.
      const near = (id: string, after: boolean) => (id === "" ? (after ? rules.length : 0) : rules.findIndex((r) => r.id === id) + (after ? 1 : 0));
      const at = position?.index ? position.index - 1 : position && "before" in position ? near(position.before, false) : position && "after" in position ? near(position.after, true) : rules.length;
      if (at < 0 || at > rules.length) return json({ success: false, errors: [{ code: 400, message: "index out of range" }] }, 400);
      rules.splice(at, 0, { id: newId("rule"), ...rule });
      return ok(structuredClone(rs));
    }
    if ((m = p.match(/^\/zones\/([^/]+)\/rulesets\/([^/]+)\/rules\/([^/]+)$/))) {
      const rs = this.waf[m[1]!];
      const i = rs && rs.id === m[2] ? (rs.rules ?? []).findIndex((r) => r.id === m![3]) : -1;
      if (!rs || i < 0) return json({ success: false, errors: [{ code: 404, message: "rule not found" }] }, 404);
      if (method === "PATCH") {
        rs.rules![i] = { ...rs.rules![i]!, ...body, id: m[3]! };
        return ok(structuredClone(rs));
      }
      if (method === "DELETE") {
        rs.rules!.splice(i, 1);
        return ok(structuredClone(rs));
      }
    }
    return json({ success: false, errors: [{ code: 7000, message: `no route ${method} ${p}` }] }, 400);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The example fixture: tunnels with manual rules that must survive, a few droplets. */
export function exampleFixture(): FakeCloudflare {
  const f = new FakeCloudflare();
  // The blr1 tunnel carries a MANUAL published application with originRequest.
  f.tunnels[T_BLR1]!.config = {
    ingress: [
      { hostname: "manual-dashboard.example.com", service: "https://10.0.1.13:443", originRequest: { originServerName: "dashboard.internal.example.com" } },
      { service: "http_status:404" },
    ],
    "warp-routing": { enabled: true },
  };
  // The nyc1 tunnel carries manual spike-* rules, one of which starts with ssh-.
  f.tunnels[T_NYC1]!.config = {
    ingress: [
      { hostname: "ssh-spike.example.com", service: "ssh://localhost:22" },
      { hostname: "pg-spike.example.com", service: "tcp://localhost:55432" },
      { service: "http_status:404" },
    ],
    originRequest: { connectTimeout: 30 },
  };
  f.apps.push({ id: "manual-spike-a", name: "spike-a (temporary)", type: "self_hosted", domain: "ssh-spike.example.com" });
  f.droplets = [
    droplet(1, "staging.esim.example.com", "blr1", "10.0.1.5", ["env-staging", "ci-deploy"]),
    droplet(2, "click.example.com", "nyc1", "10.0.0.3", ["env-prod"]),
    droplet(3, "pa", "blr1", "10.0.1.9", ["env-internal"]),
    droplet(4, "tars", "nyc1", "10.0.0.8", []),
    droplet(6, "old.example.com", "ams3", "10.0.9.2", ["env-prod"]),
  ];
  // Droplets whose names break the naming rule can't have a droplet file.
  f.noFile.add("pa");
  f.noFile.add("tars");
  return f;
}

// ---------- harness: droplets + sites -> droplet files -> observe -> plan -> apply ----------

const ENVS = { "env-prod": "prod", "env-staging": "staging", "env-internal": "internal" } as const;

/**
 * The droplet file for a Worker-style droplet: its tags and site, converted as the export does
 * (src/export/convert.ts), so every ported Worker scenario also tests that mapping.
 */
function fileFor(f: FakeCloudflare, name: string, tags: string[]): DropletFile {
  const envs = tags.filter((t): t is keyof typeof ENVS => t in ENVS).map((t) => ENVS[t]);
  const staff = tags.includes("web-staff");
  const pub = tags.includes("web-public");
  if (staff && pub) throw new Error(`${name}: a droplet file can't have both web-staff and web-public`);
  if (envs.length > 1) throw new Error(`${name}: a droplet file has at most one env`);
  const site = f.sites[name];
  const { spec } = convertLegacy(
    {
      name,
      ...(envs[0] ? { env: envs[0] } : {}),
      ciDeploy: tags.includes("ci-deploy"),
      ...(staff || pub ? { exposure: staff ? ("staff" as const) : ("public" as const) } : {}),
      ...(site ? { site: { ...site, ...(site.exceptions ? { exceptions: site.exceptions.map((e) => ({ ...e })) } : {}) } } : {}),
      frozen: f.frozen.has(name),
      people: f.ssh[name] ?? ["admins"],
    },
    f.ciTokens,
  );
  if (f.web[name]) spec.web = structuredClone(f.web[name]);
  const res = dropletFromData(spec, `droplets/${name}.yaml`);
  if (!res.file) throw new Error(`${name}: the converted droplet file does not load: ${JSON.stringify(res.diagnostics)}`);
  // allow.tunnel as written, without the loader's rules (some tests plan routes the loader rejects).
  const tunnel: AllowTunnel[] = (f.routes[name] ?? []).map((r) => ({ route: r.route, port: parsePort(r.port), who: r.who.map(parseWho) }));
  return { ...res.file, allow: { ...res.file.allow, tunnel } };
}

export function desiredFor(f: FakeCloudflare, account: AccountConfig = testAccount()): DesiredState {
  const files: InfraConfig["droplets"] = [];
  for (const d of f.droplets) {
    if (f.noFile.has(d.name) || files.some((x) => x.file.name === d.name)) continue;
    files.push({ file: fileFor(f, d.name, d.tags), source: `droplets/${d.name}.yaml` });
  }
  for (const [name, c] of Object.entries(f.toCreate)) {
    files.push({ file: { ...fileFor(f, name, [`env-${c.env}`, ...(c.tags ?? [])]), profile: "ubuntu-6" }, source: `droplets/${name}.yaml` });
  }
  files.sort((a, b) => a.file.name.localeCompare(b.file.name));
  const profiles = { "ubuntu-6": { name: "ubuntu-6", size: "s-1vcpu-1gb", image: "ubuntu-26-04-x64", user_data: "x.yaml", userDataText: "", source: "profiles/ubuntu-6.yaml" } };
  const config: InfraConfig = { account, profiles, droplets: files };
  const observed: ObservedDroplet[] = f.droplets.map((d) => ({
    id: d.id,
    name: d.name,
    region: d.region,
    ...(d.privateIp ? { privateIpv4: d.privateIp } : {}),
    publicIpv4: d.publicIp,
    tags: d.tags,
    status: "active",
  }));
  return buildDesired(config, observed);
}

export function testContext(f: FakeCloudflare, account: AccountConfig = testAccount(), allowWrites = true): RunContext {
  return {
    mode: allowWrites ? "apply" : "check",
    account,
    secrets: new Secrets({ CF_API_TOKEN: CF_TOKEN }),
    fetch: f.fetch,
    allowWrites,
    now: () => new Date("2026-11-19T00:00:00Z"),
    sleep: async () => {},
  };
}

export interface RunResult {
  desired: DesiredState;
  observed: CloudflareObserved;
  plan: ModulePlan;
  result: ApplyResult;
  /** Messages of every diagnostic, by level. */
  errors: string[];
  warnings: string[];
}

/**
 * One run: observe -> plan -> (frozen droplets become report ops, as the engine does) -> apply the
 * changes. Unlike the engine, it applies even when the plan has errors, so the module's own fail-
 * closed behaviour can be tested (the engine's gate is tested in test/engine.test.ts).
 */
export async function run(f: FakeCloudflare, opts: { account?: AccountConfig; apply?: boolean } = {}): Promise<RunResult> {
  const account = opts.account ?? testAccount();
  const desired = desiredFor(f, account);
  const ctx = testContext(f, account);
  const observed = await observeCloudflare(ctx);
  const frozen = new Set(desired.droplets.filter((d) => d.frozen).map((d) => d.name));
  const plan = freezeOps(planCloudflare(desired, observed), frozen);
  const ready: PlanOp[] = plan.ops.filter((op) => isChange(op) && !op.pending);
  const result = opts.apply === false ? { module: "cloudflare" as const, applied: [], failed: [], skipped: [] } : await applyCloudflare(ctx, ready, observed);
  return {
    desired,
    observed,
    plan,
    result,
    errors: plan.diagnostics.filter((d) => d.level === "error").map((d) => d.message),
    warnings: plan.diagnostics.filter((d) => d.level === "warning").map((d) => d.message),
  };
}

/** Plan only (no writes), e.g. to check a second run is a no-op. */
export async function planOnly(f: FakeCloudflare, account: AccountConfig = testAccount()): Promise<ModulePlan> {
  return (await run(f, { account, apply: false })).plan;
}

export const changes = (p: ModulePlan) => p.ops.filter(isChange);
export const opKeys = (p: ModulePlan, action?: PlanOp["action"]) => p.ops.filter((o) => !action || o.action === action).map((o) => `${o.action} ${o.kind} ${o.key}`);

export const idx = (calls: Call[], pred: (c: Call) => boolean) => calls.findIndex(pred);
export const isTargetPost = (name: string) => (c: Call) => c.method === "POST" && c.path.endsWith("/infrastructure/targets") && c.body?.hostname === name;
export const isAppPost = (host: string) => (c: Call) => c.method === "POST" && c.path.endsWith("/access/apps") && c.body?.domain === host;
export const isTunnelPutWith = (tid: string, host: string) => (c: Call) =>
  c.method === "PUT" && c.path.includes(`/cfd_tunnel/${tid}/`) && c.body?.config?.ingress?.some((r: any) => r.hostname === host);
export const isDnsPost = (host: string) => (c: Call) => c.method === "POST" && c.path.endsWith("/dns_records") && c.body?.name === host;
