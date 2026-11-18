// Cloudflare API shapes, ported from infra-sync src/types.ts. They follow the Cloudflare
// OpenAPI schema (github.com/cloudflare/api-schemas). B1 may extend them.

export interface Zone {
  id: string;
  name: string;
  status?: string;
}

export interface InfraTarget {
  id: string;
  hostname: string;
  ip: {
    ipv4?: { ip_addr?: string; virtual_network_id?: string };
    ipv6?: { ip_addr?: string; virtual_network_id?: string };
  };
  tags?: Record<string, string>;
}

export type AccessRule =
  | { email: { email: string } }
  | { service_token: { token_id: string } }
  | { ip: { ip: string } }
  | { everyone: Record<string, never> }
  | Record<string, unknown>;

export interface AccessPolicy {
  id?: string;
  name: string;
  decision: "allow" | "deny" | "non_identity" | "bypass";
  include: AccessRule[];
  reusable?: boolean;
  exclude?: AccessRule[];
  require?: AccessRule[];
  precedence?: number;
  connection_rules?: { ssh?: { usernames: string[]; allow_email_alias?: boolean } };
}

export interface AccessApp {
  id: string;
  name?: string;
  type?: string;
  domain?: string;
  self_hosted_domains?: string[];
  destinations?: Array<{ type?: string; uri?: string; hostname?: string }>;
  session_duration?: string;
  app_launcher_visible?: boolean;
  allow_authenticate_via_warp?: boolean;
  policies?: AccessPolicy[];
  target_criteria?: unknown[];
}

export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface TunnelConfigDoc {
  ingress?: IngressRule[];
  originRequest?: Record<string, unknown>;
  [k: string]: unknown; // e.g. "warp-routing": round-tripped verbatim
}

export interface TunnelConfiguration {
  tunnel_id: string;
  source?: "local" | "cloudflare" | string;
  version?: number;
  config?: TunnelConfigDoc;
}

export interface DnsRecord {
  id: string;
  zone_id?: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  comment?: string | null;
  ttl?: number;
}

/** A read that failed for one tunnel or zone: blocks deletions (fail closed), as in the Worker. */
export interface ReadError {
  error: string;
}

/** Everything B1 reads (the Worker's Snapshot without the droplets, which come from DesiredState). */
export interface CloudflareObserved {
  zones: Zone[];
  targets: InfraTarget[];
  apps: AccessApp[];
  /** By tunnel id (every tunnel in account.cloudflare.tunnels). */
  tunnels: Record<string, TunnelConfiguration | ReadError>;
  /** By zone id: every record of the zone (ssh-, vpc-, site hostnames, dependents). */
  dns: Record<string, DnsRecord[] | ReadError>;
}
