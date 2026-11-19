// An in-memory fake of the DigitalOcean API v2 endpoints the droplets module uses: list, get and
// create droplets. It has no tag endpoints: the tool never writes DigitalOcean tags (decision 20),
// so any tag request gets a 404 and still shows up in writes().
// Fake data only: example.com names, RFC 5737 and 10.0.0.x addresses.

import type { DoDroplet } from "../../src/droplets/api.js";

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  auth?: string;
}

export interface FakeDoOptions {
  droplets?: DoDroplet[];
  /** Page size the fake uses (the client asks for 200; small pages test pagination). */
  pageSize?: number;
  /** Override meta.total. */
  metaTotal?: number;
  /** Polls of GET /droplets/{id} before a new droplet becomes active with IPs (default 2). */
  pollsUntilActive?: number;
  /** Respond with this status/body instead, when the predicate matches. */
  fail?: (c: FakeCall) => { status: number; body?: unknown } | undefined;
}

export function doDroplet(id: number, name: string, over: Partial<DoDroplet> = {}): DoDroplet {
  return {
    id,
    name,
    status: "active",
    region: { slug: "nyc1" },
    size_slug: "s-1vcpu-1gb",
    image: { slug: "ubuntu-26-04-x64" },
    tags: ["env-prod"],
    vpc_uuid: "00000000-0000-4000-8000-0000000000a1",
    created_at: "2026-01-01T00:00:00Z",
    networks: {
      v4: [
        { ip_address: `10.0.0.${id % 250}`, type: "private" },
        { ip_address: `203.0.113.${id % 250}`, type: "public" },
      ],
      v6: [],
    },
    ...over,
  };
}

export function fakeDo(opts: FakeDoOptions = {}) {
  const droplets: DoDroplet[] = (opts.droplets ?? []).map((d) => structuredClone(d));
  const calls: FakeCall[] = [];
  const polls = new Map<number, number>();
  let nextId = 9000;

  const json = (status: number, body?: unknown) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "https://api.digitalocean.com" || !url.pathname.startsWith("/v2/")) throw new Error(`unexpected host ${url.origin}`);
    const path = url.pathname.slice(3);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: FakeCall = {
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
    };
    calls.push(call);
    const forced = opts.fail?.(call);
    if (forced) return json(forced.status, forced.body ?? { id: "error", message: "forced failure" });

    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/droplets") {
      const size = opts.pageSize ?? Number(call.query.per_page ?? 20);
      const page = Number(call.query.page ?? 1);
      const slice = droplets.slice((page - 1) * size, page * size);
      const hasNext = page * size < droplets.length;
      return json(200, {
        droplets: slice,
        links: hasNext ? { pages: { next: `https://api.digitalocean.com/v2/droplets?page=${page + 1}` } } : {},
        meta: { total: opts.metaTotal ?? droplets.length },
      });
    }
    if (method === "GET" && (m = /^\/droplets\/(\d+)$/.exec(path))) {
      const id = Number(m[1]);
      const d = droplets.find((x) => x.id === id);
      if (!d) return json(404, { id: "not_found", message: "The resource you were accessing could not be found." });
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (d.status === "new" && n >= (opts.pollsUntilActive ?? 2)) {
        d.status = "active";
        d.networks = {
          v4: [
            { ip_address: `10.0.0.${id % 250}`, type: "private" },
            { ip_address: `198.51.100.${id % 250}`, type: "public" },
          ],
          v6: [],
        };
      }
      return json(200, { droplet: d });
    }
    if (method === "POST" && path === "/droplets") {
      const b = call.body as { name: string; region: string; size: string; image: string; tags?: string[] };
      const d = doDroplet(nextId++, b.name, {
        status: "new",
        region: { slug: b.region },
        size_slug: b.size,
        image: { slug: b.image },
        tags: [...(b.tags ?? [])],
        networks: { v4: [], v6: [] },
      });
      droplets.push(d);
      return json(202, { droplet: d, links: { actions: [] } });
    }
    return json(404, { id: "not_found", message: `fake has no route ${method} ${path}` });
  };

  return { fetch, calls, droplets, writes: () => calls.filter((c) => c.method !== "GET") };
}
