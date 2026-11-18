// Cloudflare API v4, the endpoints the Worker used (src/clients/cloudflare.ts there), over the
// shared ApiClient: a client built for a read-only run refuses every write before any request.

import { ApiClient, type FetchFn } from "../core/http.js";
import type { AccessApp, DnsRecord, InfraTarget, TunnelConfigDoc, TunnelConfiguration, Zone } from "./types.js";

export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_PAGES = 100;

interface Envelope<T> {
  result?: T;
  result_info?: { total_pages?: number };
}

export class CfClient {
  constructor(
    readonly api: ApiClient,
    private readonly accountId: string,
  ) {}

  static create(opts: { token: string; accountId: string; fetch: FetchFn; allowWrites: boolean }): CfClient {
    const api = new ApiClient({
      baseUrl: CF_API_BASE,
      headers: { Authorization: `Bearer ${opts.token}` },
      fetch: opts.fetch,
      allowWrites: opts.allowWrites,
      name: "cloudflare",
    });
    return new CfClient(api, opts.accountId);
  }

  private get acct() {
    return `/accounts/${this.accountId}`;
  }

  private async listAll<T>(path: string, query: Record<string, string>, perPage: number): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.api.get<Envelope<T[]>>(path, { ...query, per_page: perPage, page });
      const result: T[] = Array.isArray(body.result) ? body.result : [];
      out.push(...result);
      const totalPages = body.result_info?.total_pages;
      if (result.length === 0) break;
      if (typeof totalPages === "number") {
        if (page >= totalPages) break;
      } else if (result.length < perPage) {
        break; // no result_info: keep paging while pages come back full, never truncate silently
      }
      if (page === MAX_PAGES) throw new Error(`cloudflare GET ${path}: more than ${MAX_PAGES} pages; refusing a partial read`);
    }
    return out;
  }

  private async result<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.api.request<Envelope<T>>(method, path, body === undefined ? {} : { body });
    return res.result as T;
  }

  // ---------- reads ----------

  /** GET /zones?account.id= (per_page max 50). */
  listZones(): Promise<Zone[]> {
    return this.listAll<Zone>("/zones", { "account.id": this.accountId }, 50);
  }
  listTargets(): Promise<InfraTarget[]> {
    return this.listAll<InfraTarget>(`${this.acct}/infrastructure/targets`, {}, 1000);
  }
  listAccessApps(): Promise<AccessApp[]> {
    return this.listAll<AccessApp>(`${this.acct}/access/apps`, {}, 1000);
  }
  getTunnelConfig(tunnelId: string): Promise<TunnelConfiguration> {
    return this.result<TunnelConfiguration>("GET", `${this.acct}/cfd_tunnel/${tunnelId}/configurations`);
  }
  /** Every record of the zone (all types): ssh-, vpc-, site names and their dependents. */
  listDnsRecords(zoneId: string): Promise<DnsRecord[]> {
    return this.listAll<DnsRecord>(`/zones/${zoneId}/dns_records`, {}, 5000);
  }

  // ---------- writes ----------

  createTarget(b: unknown): Promise<InfraTarget> {
    return this.result("POST", `${this.acct}/infrastructure/targets`, b);
  }
  updateTarget(id: string, b: unknown): Promise<InfraTarget> {
    return this.result("PUT", `${this.acct}/infrastructure/targets/${id}`, b);
  }
  async deleteTarget(id: string): Promise<void> {
    await this.api.request("DELETE", `${this.acct}/infrastructure/targets/${id}`);
  }
  createApp(b: unknown): Promise<AccessApp> {
    return this.result("POST", `${this.acct}/access/apps`, b);
  }
  updateApp(id: string, b: unknown): Promise<AccessApp> {
    return this.result("PUT", `${this.acct}/access/apps/${id}`, b);
  }
  async deleteApp(id: string): Promise<void> {
    await this.api.request("DELETE", `${this.acct}/access/apps/${id}`);
  }
  /** PUT replaces the whole document: callers send back every key they read. */
  async putTunnelConfig(tunnelId: string, config: TunnelConfigDoc): Promise<void> {
    await this.api.request("PUT", `${this.acct}/cfd_tunnel/${tunnelId}/configurations`, { body: { config } });
  }
  createDns(zoneId: string, b: unknown): Promise<DnsRecord> {
    return this.result("POST", `/zones/${zoneId}/dns_records`, b);
  }
  patchDns(zoneId: string, id: string, b: unknown): Promise<DnsRecord> {
    return this.result("PATCH", `/zones/${zoneId}/dns_records/${id}`, b);
  }
  async deleteDns(zoneId: string, id: string): Promise<void> {
    await this.api.request("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }
}
