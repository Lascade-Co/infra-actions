// Cloudflare API shapes, ported from infra-sync src/types.ts. They follow the Cloudflare
// OpenAPI schema (github.com/cloudflare/api-schemas). B1 may extend them.

export interface Zone {
  id: string;
  name: string;
  status?: string;
  /** The zone's plan, as GET /zones returns it (legacy_id: free | pro | business | enterprise). */
  plan?: { legacy_id?: string; name?: string };
}

/** One rule of a zone's http_request_firewall_custom entry point ruleset (WAF custom rules). */
export interface WafRule {
  id: string;
  description?: string;
  action?: string;
  expression?: string;
  enabled?: boolean;
}

/** A zone's http_request_firewall_custom entry point ruleset. */
export interface WafRuleset {
  id: string;
  rules?: WafRule[];
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
  /**
   * By zone id: the zone's WAF custom rules entry point ruleset (decision 21); null when the zone
   * has none yet (404). A failed read is an error in the plan (it blocks the apply).
   */
  waf: Record<string, WafRuleset | null | ReadError>;
}

// ---------- Dependents (names that point at a site; guard rail 1) ----------

/**
 * A DNS record in any account zone that sends traffic to a site without being one of its own records:
 *  - implicit:     proxied CNAME (or chain) to a site hostname; served as an extra hostname of that site
 *  - declared:     a CNAME to a site hostname that is itself a site hostname (listed in a droplet file)
 *  - dns-only:     DNS-only CNAME to a site hostname (error: breaks once the target is a tunnel CNAME)
 *  - multi-level:  proxied CNAME more than one level under its zone (error: no certificate, no route)
 *  - uncoverable:  proxied CNAME that can't be a site hostname (a zone apex, another droplet's name, ssh-/vpc-)
 *  - direct-ip:    A/AAAA to the droplet's public IP (warning: breaks when origin ports close)
 */
export type DependentKind = "implicit" | "declared" | "dns-only" | "multi-level" | "uncoverable" | "direct-ip";

export interface Dependent {
  /** Droplet name. */
  site: string;
  /** The site hostname it reaches (or the droplet name, for direct-ip). */
  target: string;
  /** The dependent record's name. */
  name: string;
  zoneId: string;
  /** CNAME | A | AAAA */
  type: string;
  content: string;
  proxied: boolean;
  /** Intermediate CNAME names, in order (empty: points straight at the target). */
  via: string[];
  kind: DependentKind;
  level: "ok" | "warning" | "error";
  detail: string;
}
