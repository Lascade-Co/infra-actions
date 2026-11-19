// DigitalOcean API v2: the droplet and tag endpoints the droplets module uses.
// https://docs.digitalocean.com/reference/api/digitalocean/#tag/Droplets
//
// Reads fail closed, as the Worker's listDroplets did (infra-sync src/clients/digitalocean.ts):
// any failed page, a count that does not match meta.total, an empty list or droplets without
// tags/networks throw, so nothing is planned from a partial picture.

import { ApiClient, type FetchFn } from "../core/http.js";
import type { Secrets } from "../core/secrets.js";

export const DO_BASE_URL = "https://api.digitalocean.com/v2";
/** Documented maximum page size. */
export const PER_PAGE = 200;
/** 50 pages of 200: far more droplets than the account will ever have. */
export const MAX_PAGES = 50;

export interface DoNetworkV4 {
  ip_address: string;
  type: "public" | "private" | string;
}

export interface DoNetworkV6 {
  ip_address: string;
  type: "public" | string;
}

/** The fields of a DigitalOcean droplet object the tool reads. */
export interface DoDroplet {
  id: number;
  name: string;
  status?: string;
  region?: { slug?: string };
  size_slug?: string;
  image?: { slug?: string | null };
  tags?: string[];
  vpc_uuid?: string;
  created_at?: string;
  networks?: { v4?: DoNetworkV4[]; v6?: DoNetworkV6[] };
}

interface DropletsPage {
  droplets?: unknown;
  meta?: { total?: unknown };
  links?: { pages?: { next?: unknown } };
}

/** A DigitalOcean API client for one run (writes refused unless the run is an apply). */
export function doClient(opts: { secrets: Secrets; fetch: FetchFn; allowWrites: boolean }): ApiClient {
  return new ApiClient({
    baseUrl: DO_BASE_URL,
    headers: { Authorization: `Bearer ${opts.secrets.require("DO_TOKEN")}` },
    fetch: opts.fetch,
    allowWrites: opts.allowWrites,
    name: "digitalocean",
  });
}

/**
 * Every droplet in the account (all pages). Throws on any failed page, a count that does
 * not match meta.total, more pages than MAX_PAGES, an empty list, a droplet without
 * name/tags/networks.v4, or no droplet having any tag (the token lacks tag:read).
 */
export async function listAllDroplets(api: ApiClient): Promise<DoDroplet[]> {
  const all: unknown[] = [];
  let total: number | undefined;
  let more = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api.get<DropletsPage>("/droplets", { per_page: PER_PAGE, page });
    if (!Array.isArray(body.droplets)) throw new Error(`DigitalOcean droplets page ${page} has no droplets array`);
    all.push(...(body.droplets as unknown[]));
    total = typeof body.meta?.total === "number" ? body.meta.total : undefined;
    more = Boolean(body.links?.pages?.next) && body.droplets.length > 0;
    if (!more) break;
  }
  if (more) throw new Error(`DigitalOcean droplets: still more pages after ${MAX_PAGES}; refusing to plan from a partial list`);
  if (total === undefined) throw new Error("DigitalOcean droplets response has no meta.total");
  if (all.length !== total) throw new Error(`DigitalOcean returned ${all.length} droplets but meta.total=${total}`);
  if (all.length === 0) throw new Error("DigitalOcean returned zero droplets; refusing to plan");
  const droplets = all.map(checkDroplet);
  if (droplets.every((d) => d.tags!.length === 0)) {
    throw new Error("no droplet has any tag; the DO token is probably missing the tag:read scope");
  }
  return droplets;
}

/** One droplet by id (GET /v2/droplets/{id}). */
export async function getDroplet(api: ApiClient, id: number): Promise<DoDroplet> {
  const body = await api.get<{ droplet?: unknown }>(`/droplets/${id}`);
  return checkDroplet(body.droplet);
}

/** Throws unless the object has the fields every plan relies on. */
export function checkDroplet(raw: unknown): DoDroplet {
  const d = raw as Partial<DoDroplet> | null;
  const id = typeof d?.id === "number" ? d.id : "(no id)";
  if (!d || typeof d.id !== "number" || typeof d.name !== "string") {
    throw new Error(`DigitalOcean droplet ${id} has no id or name`);
  }
  if (!Array.isArray(d.tags) || !Array.isArray(d.networks?.v4)) {
    throw new Error(`droplet ${id} has no tags/networks.v4; is the DO token missing tag:read?`);
  }
  if (typeof d.region?.slug !== "string") throw new Error(`droplet ${id} has no region slug`);
  return d as DoDroplet;
}
