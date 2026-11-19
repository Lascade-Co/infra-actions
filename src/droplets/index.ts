// B4: droplet creation (create-only). See README.md in this folder.
//
// Safety:
//  - create-only: the only write is POST /v2/droplets for a name that does not exist yet. Nothing
//    is resized, rebuilt, renamed or deleted, and no tag is ever added to or removed from an
//    existing droplet (decision 20: the droplet file is the only source of truth). A droplet the
//    tool creates is created with the old firewall tag of its env (FIREWALL_TAGS), so today's
//    tag-attached firewalls cover it from birth;
//  - a create is never retried: the name is checked against a fresh list first, and any error
//    stops the apply (a later apply sees the droplet if the failed request did create it);
//  - user_data never appears in a plan op or a message, only in the POST body.

import type { DesiredDroplet, DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import type { ApiClient } from "../core/http.js";
import type { DropletsObserved, ObservedDroplet } from "../core/observed.js";
import type { ApplyResult, ModulePlan, OpFailure, PlanOp, Provider, RunContext } from "../core/plan.js";
import { checkDroplet, doClient, getDroplet, listAllDroplets, type DoDroplet } from "./api.js";

export type { DropletsObserved } from "../core/observed.js";

/** The droplets provider is observed first: the engine builds the desired state from it. */
export interface DropletsProvider extends Provider<DropletsObserved> {
  /** GET /v2/droplets (all pages). Needs no desired state. observe() returns the same. */
  observeDroplets(): Promise<DropletsObserved>;
}

/** POST /v2/droplets body for a droplet with status "create". */
export interface DoCreateDropletBody {
  name: string;
  region: string;
  size: string;
  image: string;
  /** The profile's cloud-init text. No vpc_uuid: the region's default VPC is used. */
  user_data: string;
  tags: string[];
  monitoring: boolean;
  ipv6: boolean;
  backups: boolean;
}

/** How long apply waits for new droplets: MAX_POLLS x POLL_INTERVAL_MS = 5 minutes. */
export const POLL_INTERVAL_MS = 5_000;
export const MAX_POLLS = 60;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Maps one DigitalOcean API droplet object to the shared observed shape. Throws on a malformed one. */
export function toObservedDroplet(apiDroplet: unknown): ObservedDroplet {
  const d: DoDroplet = checkDroplet(apiDroplet);
  const v4 = d.networks?.v4 ?? [];
  const privateIpv4 = v4.find((n) => n.type === "private")?.ip_address;
  const publicIpv4 = v4.find((n) => n.type === "public")?.ip_address;
  const publicIpv6 = (d.networks?.v6 ?? []).find((n) => n.type === "public")?.ip_address;
  return {
    id: d.id,
    name: d.name,
    region: d.region!.slug!,
    ...(privateIpv4 ? { privateIpv4 } : {}),
    ...(publicIpv4 ? { publicIpv4 } : {}),
    ...(publicIpv6 ? { publicIpv6 } : {}),
    tags: [...d.tags!],
    ...(d.vpc_uuid ? { vpcUuid: d.vpc_uuid } : {}),
    status: d.status ?? "unknown",
    ...(d.size_slug ? { sizeSlug: d.size_slug } : {}),
    ...(d.image?.slug ? { imageSlug: d.image.slug } : {}),
    ...(d.created_at ? { createdAt: d.created_at } : {}),
  };
}

/** The create request for a droplet with status "create" (profile + env region + the env's firewall tag). */
export function createRequest(d: DesiredDroplet): DoCreateDropletBody {
  if (d.status !== "create") throw new Error(`${d.name}: only a droplet with status "create" has a create request (status ${d.status})`);
  if (!d.profile) throw new Error(`${d.name}: profile ${d.spec.profile ?? "(none)"} is not loaded`);
  if (!d.region) throw new Error(`${d.name}: no region (the region follows env, and the file has none)`);
  return {
    name: d.name,
    region: d.region,
    size: d.profile.size,
    image: d.profile.image,
    user_data: d.profile.userDataText,
    tags: [...d.tags],
    monitoring: true,
    ipv6: false,
    backups: false,
  };
}

/** The create request as a plan shows it: everything but user_data. */
function createAfter(body: DoCreateDropletBody, profile: string): PlanOp["after"] {
  const { user_data: _omit, ...rest } = body;
  return { ...rest, tags: [...rest.tags], profile };
}

/**
 * Pure. Ops: kind "droplet", action "create", for each status "create" droplet (after: the create
 * request, user_data elided). Existing droplets get no op: their tags are never written (decision 20).
 * Never resize, rebuild or delete: differences in size/image/region are at most info diagnostics.
 */
export function planDroplets(desired: DesiredState, _observed: DropletsObserved): ModulePlan {
  const ops: PlanOp[] = [];
  const diagnostics: Diagnostic[] = [];
  let unchanged = 0;

  for (const d of desired.droplets) {
    if (d.status === "create") {
      let body: DoCreateDropletBody;
      try {
        body = createRequest(d);
      } catch (e) {
        diagnostics.push({ level: "error", code: "droplet-create-unresolved", file: d.source, droplet: d.name, message: `cannot create: ${errText(e)}` });
        continue;
      }
      ops.push({
        provider: "digitalocean",
        module: "droplets",
        kind: "droplet",
        key: d.name,
        action: "create",
        before: null,
        after: createAfter(body, d.profile!.name),
        reason: `new droplet from profile ${d.profile!.name} (${body.size}, ${body.image}) in ${body.region}, the region of env ${d.env}${body.tags.length ? `, tagged ${body.tags.join(", ")} for today's firewalls` : ""}`,
        droplet: d.name,
      });
      continue;
    }
    if (d.status !== "exists" || !d.observed) continue; // missing / conflict: buildDesired already reported them

    diagnostics.push(...profileDrift(desired, d, d.observed));
    unchanged++;
  }
  return { module: "droplets", ops, unchanged, diagnostics };
}

/** Info diagnostics when an existing droplet no longer matches the profile its file names. Never an op. */
function profileDrift(desired: DesiredState, d: DesiredDroplet, obs: ObservedDroplet): Diagnostic[] {
  const name = d.spec.profile;
  const profile = name ? desired.profiles[name] : undefined;
  if (!name || !profile) return [];
  const diffs: string[] = [];
  if (obs.sizeSlug && obs.sizeSlug !== profile.size) diffs.push(`size ${obs.sizeSlug} (profile: ${profile.size})`);
  if (obs.imageSlug && obs.imageSlug !== profile.image) diffs.push(`image ${obs.imageSlug} (profile: ${profile.image})`);
  const envRegion = d.env ? desired.account.digitalocean.regions[d.env] : undefined;
  if (envRegion && obs.region !== envRegion) diffs.push(`region ${obs.region} (env ${d.env}: ${envRegion})`);
  if (!diffs.length) return [];
  return [
    {
      level: "info",
      code: "droplet-profile-drift",
      file: d.source,
      droplet: d.name,
      message: `differs from profile ${name}: ${diffs.join(", ")}. The tool is create-only and changes nothing; resize or rebuild by hand if needed`,
    },
  ];
}

export interface ApplyDropletsOptions {
  /** Create bodies by droplet name, from the provider's last diff (user_data is not in the ops). */
  requests?: ReadonlyMap<string, DoCreateDropletBody>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const isCreate = (op: PlanOp) => op.kind === "droplet" && op.action === "create";

/**
 * Performs the ops in order: creates, then waits (ctx.sleep, bounded) until every new droplet is
 * active with a public and a private IPv4. Anything else (a tag change included) is refused. Stops at the first error: the failed
 * op is reported and every op after it is skipped. Returns ApplyResult; the engine re-observes after.
 */
export async function applyDroplets(ctx: RunContext, ops: PlanOp[], opts: ApplyDropletsOptions = {}): Promise<ApplyResult> {
  const result: ApplyResult = { module: "droplets", applied: [], failed: [], skipped: [] };
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxPolls = opts.maxPolls ?? MAX_POLLS;

  // 1. Refuse anything this module may not do before sending a single request.
  const todo: PlanOp[] = [];
  const refused: OpFailure[] = [];
  for (const op of ops) {
    if (op.action === "report") result.skipped.push({ op, reason: "report only" });
    else if (op.module !== "droplets" || op.provider !== "digitalocean") refused.push({ op, error: `refused: not a droplets op (${op.module})` });
    else if (isCreate(op)) todo.push(op);
    else if (op.kind === "droplet-tags") refused.push({ op, error: "refused: the tool never writes DigitalOcean tags (decision 20)" });
    else refused.push({ op, error: `refused: create-only, the tool never does ${op.action} on ${op.kind}` });
  }
  const creates = todo;
  for (const op of creates) {
    if (!opts.requests?.get(op.key)) refused.push({ op, error: "refused: no create request for this droplet in the current plan" });
  }
  if (refused.length) {
    result.failed.push(...refused);
    const bad = new Set(refused.map((f) => f.op));
    result.skipped.push(...todo.filter((op) => !bad.has(op)).map((op) => ({ op, reason: "not applied: another droplets op was refused" })));
    return result;
  }

  let api: ApiClient;
  try {
    api = doClient({ secrets: ctx.secrets, fetch: ctx.fetch, allowWrites: ctx.allowWrites });
  } catch (e) {
    const [first, ...rest] = todo;
    if (first) result.failed.push({ op: first, error: errText(e) });
    result.skipped.push(...rest.map((op) => ({ op, reason: "not applied: an earlier droplets op failed" })));
    return result;
  }

  // Stops the run at `op`: droplets created so far stay applied (they exist), `op` failed,
  // every later op skipped.
  const queue = [...creates];
  const created: Array<{ op: PlanOp; id: number }> = [];
  const settled = new Set<PlanOp>();
  const markApplied = (op: PlanOp, applied: PlanOp = op) => {
    settled.add(op);
    result.applied.push(applied);
  };
  const markFailed = (op: PlanOp, error: string) => {
    settled.add(op);
    result.failed.push({ op, error });
  };
  const withId = (c: { op: PlanOp; id: number }): PlanOp => ({ ...c.op, ids: { ...c.op.ids, droplet_id: String(c.id) } });
  const stopped = (): ApplyResult => {
    for (const c of created) if (!settled.has(c.op)) markApplied(c.op, withId(c));
    for (const rest of queue) if (!settled.has(rest)) result.skipped.push({ op: rest, reason: "not applied: an earlier droplets op failed" });
    return result;
  };
  const stop = (op: PlanOp, error: string): ApplyResult => {
    markFailed(op, error);
    return stopped();
  };

  // 2. Creates. Check names against a fresh list first so a create is never repeated.
  if (creates.length) {
    let existing: Set<string>;
    try {
      existing = new Set((await listAllDroplets(api)).map((d) => d.name));
    } catch (e) {
      return stop(creates[0]!, `could not list droplets before creating: ${errText(e)}`);
    }
    for (const op of creates) {
      if (existing.has(op.key)) return stop(op, `a droplet named ${op.key} already exists; not creating another`);
    }
    for (const op of creates) {
      let id: unknown;
      try {
        const res = await api.request<{ droplet?: { id?: unknown } }>("POST", "/droplets", { body: opts.requests!.get(op.key)! });
        id = res.droplet?.id;
      } catch (e) {
        // Not retried: the request may have created the droplet anyway; the next run sees it by name.
        return stop(op, `create failed (not retried): ${errText(e)}`);
      }
      if (typeof id !== "number") return stop(op, "create answered without a droplet id (not retried); check the account by name");
      created.push({ op, id });
    }
  }

  // 3. Wait until every new droplet is active with a public and a private IPv4.
  if (created.length) {
    const waiting = new Map(created.map((c) => [c.id, c]));
    const last = new Map<number, string>();
    for (let poll = 0; poll < maxPolls && waiting.size; poll++) {
      await ctx.sleep(pollIntervalMs);
      for (const [id, c] of [...waiting]) {
        try {
          const d = toObservedDroplet(await getDroplet(api, id));
          if (d.status === "active" && d.privateIpv4 && d.publicIpv4) {
            waiting.delete(id);
            markApplied(c.op, withId(c));
          } else {
            last.set(id, `status ${d.status}, private IPv4 ${d.privateIpv4 ? "yes" : "no"}, public IPv4 ${d.publicIpv4 ? "yes" : "no"}`);
          }
        } catch (e) {
          last.set(id, `last read failed: ${errText(e)}`); // reads are safe to repeat until the deadline
        }
      }
    }
    if (waiting.size) {
      const secs = Math.round((maxPolls * pollIntervalMs) / 1000);
      const msg = (c: { id: number }) => `created as id ${c.id} but not active with public and private IPv4 after ${secs}s (${last.get(c.id) ?? "no answer"})`;
      for (const c of waiting.values()) markFailed(c.op, msg(c));
      return stopped();
    }
  }

  return result;
}

export function createDropletsProvider(ctx: RunContext): DropletsProvider {
  // The create bodies of the last diff: apply needs user_data, which the ops never carry.
  let requests = new Map<string, DoCreateDropletBody>();

  const observeDroplets = async (): Promise<DropletsObserved> => {
    const api = doClient({ secrets: ctx.secrets, fetch: ctx.fetch, allowWrites: false });
    return { droplets: (await listAllDroplets(api)).map(toObservedDroplet) };
  };
  return {
    module: "droplets",
    observeDroplets,
    observe: () => observeDroplets(),
    diff: (desired, observed) => {
      const plan = planDroplets(desired, observed);
      requests = new Map(
        desired.droplets.filter((d) => d.status === "create" && plan.ops.some((op) => op.kind === "droplet" && op.key === d.name)).map((d) => [d.name, createRequest(d)]),
      );
      return plan;
    },
    apply: (ops) => applyDroplets(ctx, ops, { requests }),
  };
}
