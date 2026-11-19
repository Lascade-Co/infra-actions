// Names and defaults shared by every module. Values that identify the ownership of
// existing objects are the same as the infra-sync Worker's (src/config.ts there), so the
// tool adopts what the Worker created without importing anything (decision 8, 9.4).

import type { EnvName } from "./model.js";

/** Ownership marker. Never change it: it is how existing objects are recognised. */
export const MARKER = "infra-sync";
/** Prefix of Access app and policy names the tool owns. */
export const NAME_PREFIX = "infra-sync:";
/** Comment on every DNS record the tool owns. */
export const DNS_COMMENT_MARKER = "managed-by:infra-sync";
/** Tag on every Access for Infrastructure target the tool owns. */
export const TARGET_TAG_KEY = "managed-by";
export const TARGET_TAG_VALUE = "infra-sync";

// ---------- Cloudflare object names (the Worker's, unchanged) ----------

/**
 * Access for Infrastructure apps (decision 18): one per distinct SSH access set, named
 * "infra-sync: SSH <set id>", covering the targets tagged SSH_ACCESS_TAG_KEY=<set id>. Every
 * infrastructure app whose name starts with this prefix is the tool's, including the Worker's
 * single app (LEGACY_INFRA_APP_NAME), which is removed once every target is covered by a set app.
 */
export const INFRA_APP_PREFIX = "infra-sync: SSH ";
/** The Worker's one infrastructure app (every target tagged managed-by=infra-sync, as ubuntu and root). */
export const LEGACY_INFRA_APP_NAME = "infra-sync: SSH targets";
/** Target tag naming the target's SSH access set (value: the set id). */
export const SSH_ACCESS_TAG_KEY = "ssh-access";
/** The only SSH username the infrastructure apps allow. Root only through the DigitalOcean web console. */
export const SSH_USERNAME = "ubuntu";
/** Public Bypass app on <droplet name>/<HEALTH_BYPASS_PATH>: web.access `/healthcheck/: [everyone]`, the droplet's own name only. */
export const HEALTH_APP_PREFIX = "infra-sync: healthcheck ";
export const HEALTH_BYPASS_PATH = "healthcheck";
/**
 * Site apps (web.access): the whole host ("/" needs anything but everyone), a path that needs a
 * login (web-admin), a path open without one, to everyone, tokens or IPs (web-exception).
 */
export const WEB_APP_PREFIX = "infra-sync: web ";
export const WEB_ADMIN_APP_PREFIX = "infra-sync: web-admin ";
export const WEB_EXCEPTION_APP_PREFIX = "infra-sync: web-exception ";
/** TTL of the vpc- A records. */
export const VPC_TTL = 60;
/** CNAME chains to a site hostname are followed this many hops (dependents, guard rail 1). */
export const MAX_CNAME_CHAIN = 4;

// ---------- DigitalOcean tags (decision 20) ----------

/**
 * The tool writes no DigitalOcean tags: the droplet file is the only source of truth. One
 * exception until migration Phase 5: a droplet the tool creates gets the old firewall tag of its
 * environment, so today's tag-attached firewalls cover it from birth (DigitalOcean's firewalls
 * "production", "internal", "staging-network" and "SSH" are attached by these tags).
 */
export const FIREWALL_TAGS: Record<EnvName, string> = {
  prod: "production",
  staging: "staging",
  internal: "internal",
};

/**
 * The tags the infra-sync Worker read (src/export turns them into droplet files). Existing tags
 * stay on the droplets; nothing writes or reads them after the switch-over.
 */
export const ENV_TAGS: Record<EnvName, string> = {
  prod: "env-prod",
  staging: "env-staging",
  internal: "env-internal",
};
export const CI_DEPLOY_TAG = "ci-deploy";
export const WEB_STAFF_TAG = "web-staff";
export const WEB_PUBLIC_TAG = "web-public";

// ---------- generated names ----------

/** SSH route prefix: ssh-<flattened label>.<zone>. */
export const SSH_PREFIX = "ssh-";
/** Private name prefix: vpc-<flattened label>.<zone>. */
export const VPC_PREFIX = "vpc-";
/** A site hostname or tunnel route may not start with these: they are generated. */
export const RESERVED_PREFIXES: readonly string[] = [SSH_PREFIX, VPC_PREFIX];

// ---------- web defaults (applied in core/desired.ts) ----------

export const DEFAULT_WEB_ORIGIN = "https://{ip}:443";
/** The Worker's protected paths of a web-public site when web-config.json set none (src/export). */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ["/admin"];
/** Health path when the file sets none: /healthcheck/ when web.access opens it to everyone, else /. */
export const DEFAULT_HEALTH_PATH_DEPLOY = "/healthcheck/";
export const DEFAULT_HEALTH_PATH = "/";

// ---------- who-lists ----------

/** Built-in who-list names: no group may take them. */
export const WHO_STAFF = "staff";
export const WHO_EVERYONE = "everyone";
export const RESERVED_GROUP_NAMES: readonly string[] = [WHO_STAFF, WHO_EVERYONE];
/** CI's service tokens are named ci-<something>: an ssh: token with this prefix wants /healthcheck/ open (src/checks). */
export const CI_TOKEN_PREFIX = "ci-";

/**
 * Placeholder for a value only known once a droplet exists (its IPs, its id). A plan for a
 * droplet that will be created shows it in `after`; apply re-plans after the droplet is up.
 */
export const KNOWN_AFTER_CREATE = "(known after create)";
