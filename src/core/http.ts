// Minimal JSON API client shared by the modules. Each module wraps the endpoints it needs.
//
// Safety: a client built with allowWrites=false refuses every method except GET before
// any request is made, so check and drift runs cannot write even through a bug.
// Error messages carry the method, path and the API's own error text, never the token.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class WriteNotAllowedError extends Error {
  constructor(method: string, path: string) {
    super(`${method} ${path} refused: this run is read-only`);
    this.name = "WriteNotAllowedError";
  }
}

export interface ApiClientOptions {
  /** e.g. https://api.cloudflare.com/client/v4 */
  baseUrl: string;
  /** Extra headers on every request (Authorization, Access service-token headers...). */
  headers: Record<string, string>;
  fetch: FetchFn;
  allowWrites: boolean;
  /** Short name for messages, e.g. "cloudflare". */
  name: string;
}

export type Query = Record<string, string | number | boolean | undefined>;

export class ApiClient {
  constructor(readonly opts: ApiClientOptions) {}

  get allowWrites(): boolean {
    return this.opts.allowWrites;
  }

  /**
   * Sends a request and returns the parsed JSON body (or {} for an empty body).
   * `read: true` marks a non-GET call that only reads (e.g. an API whose list/query endpoints
   * are POST); it is allowed in read-only runs. Use it only for endpoints documented as reads.
   */
  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; read?: boolean } = {}): Promise<T> {
    const m = method.toUpperCase();
    if (m !== "GET" && !opts.read && !this.opts.allowWrites) throw new WriteNotAllowedError(m, path);
    const qs = opts.query
      ? "?" +
        new URLSearchParams(
          Object.entries(opts.query)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]): [string, string] => [k, String(v)]),
        ).toString()
      : "";
    const res = await this.opts.fetch(`${this.opts.baseUrl}${path}${qs}`, {
      method: m,
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...this.opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return (await readJson(res, `${this.opts.name} ${m} ${path}`)) as T;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query ? { query } : {});
  }
}

/** Parses a JSON response; throws ApiError on HTTP errors or `success: false` (Cloudflare). */
export async function readJson(res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`${what}: HTTP ${res.status}, non-JSON response`, res.status);
  }
  const b = body as { success?: boolean; errors?: Array<{ code?: unknown; message?: unknown }>; message?: unknown } | null;
  if (!res.ok || b?.success === false) {
    const msgs = Array.isArray(b?.errors)
      ? b.errors.map((e) => `${String(e.code ?? "")} ${String(e.message ?? "")}`.trim()).join("; ")
      : typeof b?.message === "string"
        ? b.message
        : "";
    throw new ApiError(`${what}: HTTP ${res.status}${msgs ? ` (${msgs})` : ""}`, res.status);
  }
  return body;
}
