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

/** The one infrastructure app covering every target tagged managed-by=infra-sync. */
export const INFRA_APP_NAME = "infra-sync: SSH targets";
/** SSH usernames allowed by the infrastructure app's policy. */
export const SSH_USERNAMES: readonly string[] = ["ubuntu", "root"];
/** Public Bypass app on <droplet name>/<HEALTH_BYPASS_PATH> for every Deploy target. */
export const HEALTH_APP_PREFIX = "infra-sync: healthcheck ";
export const HEALTH_BYPASS_PATH = "healthcheck";
/** Site apps: whole host (staff), protected path (public), exception path. */
export const WEB_APP_PREFIX = "infra-sync: web ";
export const WEB_ADMIN_APP_PREFIX = "infra-sync: web-admin ";
export const WEB_EXCEPTION_APP_PREFIX = "infra-sync: web-exception ";
/** TTL of the vpc- A records. */
export const VPC_TTL = 60;
/** CNAME chains to a site hostname are followed this many hops (dependents, guard rail 1). */
export const MAX_CNAME_CHAIN = 4;

// ---------- DigitalOcean tags written from droplet files ----------

/** The Environment tag per environment. */
export const ENV_TAGS: Record<EnvName, string> = {
  prod: "env-prod",
  staging: "env-staging",
  internal: "env-internal",
};
/** Deploy target tag. */
export const CI_DEPLOY_TAG = "ci-deploy";
/** Web tags. */
export const WEB_STAFF_TAG = "web-staff";
export const WEB_PUBLIC_TAG = "web-public";
/**
 * Every tag the tool manages on a droplet. Tags outside this list (e.g. the old firewall
 * tags) are left alone: never added, never removed.
 */
export const MANAGED_TAGS: readonly string[] = [
  ENV_TAGS.prod,
  ENV_TAGS.staging,
  ENV_TAGS.internal,
  CI_DEPLOY_TAG,
  WEB_STAFF_TAG,
  WEB_PUBLIC_TAG,
];

// ---------- generated names ----------

/** SSH route prefix: ssh-<flattened label>.<zone>. */
export const SSH_PREFIX = "ssh-";
/** Private name prefix: vpc-<flattened label>.<zone>. */
export const VPC_PREFIX = "vpc-";
/** A site hostname or tunnel route may not start with these: they are generated. */
export const RESERVED_PREFIXES: readonly string[] = [SSH_PREFIX, VPC_PREFIX];

// ---------- web defaults (applied in core/desired.ts) ----------

export const DEFAULT_WEB_ORIGIN = "https://{ip}:443";
export const DEFAULT_PROTECTED_PATHS: readonly string[] = ["/admin"];
/** Health path when the file sets none: deploy targets serve /healthcheck/. */
export const DEFAULT_HEALTH_PATH_DEPLOY = "/healthcheck/";
export const DEFAULT_HEALTH_PATH = "/";

/**
 * Placeholder for a value only known once a droplet exists (its IPs, its id). A plan for a
 * droplet that will be created shows it in `after`; apply re-plans after the droplet is up.
 */
export const KNOWN_AFTER_CREATE = "(known after create)";
