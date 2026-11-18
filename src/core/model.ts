// The typed model of an `infra` checkout, as the loader returns it.
//
// These types mirror schema/*.schema.json. The schemas are the contract for the files;
// these types are the contract for the code. A change to one needs the same change to
// the other (test/core/schema.test.ts loads the example checkout through both).
//
// Values here are what the file says, after parsing and per-file normalisation only
// (ports parsed, CIDRs normalised). Defaults that depend on other fields (origin,
// protected paths, health path) are applied later, in core/desired.ts.

/** Exactly one per managed droplet; written to DigitalOcean as the Environment tag `env-<name>`. */
export type EnvName = "prod" | "staging" | "internal";
export const ENV_NAMES: readonly EnvName[] = ["prod", "staging", "internal"];

export type Protocol = "tcp" | "udp";

/** `8443/tcp`, `5000/udp` or a range `8000-8010/tcp`. `from === to` for a single port. */
export interface PortSpec {
  from: number;
  to: number;
  protocol: Protocol;
  /** The text as written in the file, for messages and plan output. */
  raw: string;
}

// ---------- account.yaml ----------

export interface AccountConfig {
  cloudflare: {
    account_id: string;
    /** Access team domain, e.g. https://example.cloudflareaccess.com (no trailing slash). */
    team_domain: string;
    /** Zones whose names droplet names (and site hostnames) live under. Lowercase. */
    zones: string[];
    /** Tunnel UUID per DigitalOcean region slug. A droplet in a region with no tunnel gets no Cloudflare side. */
    tunnels: Record<string, string>;
    /** UUID of the reusable Access policy "staff" (web apps, staff tunnel routes). */
    staff_policy_id: string;
    /** People allowed to SSH (inline Allow policies on the ssh- apps and the infrastructure app). */
    ssh_admin_emails: string[];
    /** Every Access service token the files may name, by name -> token UUID. */
    service_tokens: Record<string, string>;
    /** Service-token names (keys of service_tokens) allowed to SSH into Deploy targets, per environment. */
    ci_deploy_tokens: Record<EnvName, string[]>;
    /** Delete guard rails (the Worker's MAX_DELETES / MAX_DELETE_FRACTION). */
    guards: { max_deletes: number; max_delete_fraction: number };
  };
  digitalocean: {
    /** Region a new droplet of each environment is created in (decision 10: prod -> nyc1, else blr1). */
    regions: Record<EnvName, string>;
  };
  oneuptime?: {
    /** Base URL of the OneUptime instance (behind Access; reached with the ONEUP_ACCESS_* service token). */
    url: string;
    project_id: string;
    /** Optional OneUptime ids the tool attaches to every monitor it creates (alerting to the Telegram chat). */
    on_call_policy_ids?: string[];
  };
  github: {
    /** The private data repo, "owner/name". */
    infra_repo: string;
    /** Branch that holds only the generated ssh config (decision 4). */
    ssh_config_branch: string;
    /** File name of the ssh config on that branch. */
    ssh_config_file: string;
  };
  telegram?: {
    chat_id: string;
  };
  ssh_config: {
    /** First comment line of the generated file, e.g. "Example Co droplets". Keeps org names out of this repo. */
    title: string;
    /** SSH user written into every Host block. */
    user: string;
  };
}

// ---------- profiles/<name>.yaml ----------

export interface ProfileFile {
  name: string;
  description?: string;
  /** DigitalOcean size slug, e.g. s-1vcpu-1gb. */
  size: string;
  /** DigitalOcean image slug, pinned, e.g. ubuntu-26-04-x64. */
  image: string;
  /** cloud-init file name, relative to profiles/. */
  user_data: string;
}

export interface Profile extends ProfileFile {
  /** Contents of the user_data file. */
  userDataText: string;
  source: string;
}

// ---------- droplets/<name>.yaml ----------

export type WebExposure = "staff" | "public";

/**
 * Who an exception path is open to:
 *  - "everyone": Bypass for everyone (the Worker's "everyone");
 *  - { ips }: Bypass for these addresses (normalised CIDRs, sorted, deduplicated);
 *  - { service_tokens }: Service Auth for these named tokens (keys of account service_tokens);
 *  - both lists may be given; then either may pass.
 */
export type ExceptionAllow = "everyone" | { ips?: string[]; service_tokens?: string[] };

export interface WebException {
  path: string;
  allow: ExceptionAllow;
}

export interface WebSpec {
  /** web-staff (staff only) or web-public (everyone; protected paths need the staff login). */
  exposure: WebExposure;
  /** e.g. "http://{ip}:80". Default (applied in desired): https://{ip}:443 with noTLSVerify. */
  origin?: string;
  /** Extra one-level hostnames the droplet serves, besides its own name. */
  hostnames: string[];
  /** web-public only. Default ["/admin"]. */
  protected_paths?: string[];
  exceptions: WebException[];
  /** Default "/healthcheck/" when deploy is true, else "/". */
  health_path?: string;
  health_accept_app_404: boolean;
}

export interface MonitorSpec {
  type: "http";
  /** One of the site hostnames (droplet name or web.hostnames). */
  hostname: string;
  /** Default web.health_path (after defaults). */
  path?: string;
  /** Default web.health_accept_app_404. */
  accept_app_404?: boolean;
}

export interface AllowDroplet {
  /** Name of another droplet file (the caller). */
  from: string;
  ports: PortSpec[];
  note?: string;
}

/** `staff` or `service-token:<name>` (name: a key of account service_tokens). */
export type Who = { kind: "staff" } | { kind: "service-token"; name: string };

export interface AllowTunnel {
  /** Hostname of the tunnel route (one level under an account zone). */
  route: string;
  port: PortSpec;
  who: Who[];
  note?: string;
}

export interface AllowIp {
  /** Normalised CIDR (a bare address becomes /32 or /128). */
  from: string;
  ports: PortSpec[];
  note?: string;
}

export interface AllowSpec {
  droplet: AllowDroplet[];
  tunnel: AllowTunnel[];
  ip: AllowIp[];
}

export type SwarmRole = "manager" | "worker";
export interface SwarmSpec {
  cluster: string;
  role: SwarmRole;
  /** The overlay network is encrypted (adds ESP, IP protocol 50, between members). Members must agree. */
  encrypted_overlay: boolean;
}

export interface DropletFile {
  /** The Droplet name: a lowercase domain, equal to the file name without .yaml. */
  name: string;
  description?: string;
  /** Droplet profile. Set only for droplets the tool creates; adopted existing droplets have none. */
  profile?: string;
  env?: EnvName;
  /** Deploy target (the `ci-deploy` tag). */
  deploy: boolean;
  /** The plan shows this droplet's changes, but apply skips them (e.g. a droplet that needs an owner's go-ahead). */
  frozen: boolean;
  web?: WebSpec;
  /** undefined: default monitors (one per site hostname when web is set). [] : none. */
  monitors?: MonitorSpec[];
  allow: AllowSpec;
  swarm?: SwarmSpec;
}

/** Where a value came from, for messages. `path` is a dotted path such as web.exceptions[0].path. */
export interface SourceRef {
  file: string; // relative to the infra checkout, e.g. droplets/app.example.com.yaml
  path?: string;
  line?: number;
}

export interface DropletEntry {
  file: DropletFile;
  source: string;
}

/** The whole checkout. Droplets are sorted by name. */
export interface InfraConfig {
  account: AccountConfig;
  profiles: Record<string, Profile>;
  droplets: DropletEntry[];
}
