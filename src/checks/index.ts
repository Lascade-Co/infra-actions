// B2: checks beyond the schema. Contract only; see README.md in this folder.
//
// The loader (src/core/loader.ts) already did the single-file rules. These are the
// cross-file and account-dependent ones. All functions are pure and return diagnostics
// (code + file + path + droplet), never throw for a rule violation.

import type { DesiredState } from "../core/desired.js";
import type { Diagnostic } from "../core/diagnostics.js";
import { notImplemented } from "../core/diagnostics.js";
import type { InfraConfig } from "../core/model.js";

/**
 * Offline checks (no API): run on every PR, before anything is observed.
 *  - naming: name is in an account zone (flattenName), flattened names don't collide;
 *  - site hostnames and tunnel routes are One-level names in an account zone; no hostname
 *    claimed by two files (or equal to another droplet's name);
 *  - references: profile exists; allow.droplet.from names a droplet file; service-token
 *    names (who, exception allow.service_tokens) exist in account.cloudflare.service_tokens;
 *  - deploy needs a ci_deploy_tokens entry for its env (warning, as the Worker);
 *  - allow.tunnel: /udp only with who: [staff] (reason in the message);
 *  - swarm: at least one manager per cluster; members agree on encrypted_overlay.
 */
export function checkConfig(_config: InfraConfig): Diagnostic[] {
  return notImplemented("checks.checkConfig");
}

/**
 * Checks that need the observed droplets (after the join in core/desired.ts):
 *  - swarm members are in one region;
 *  - allow.droplet across regions: warning (public IP, no VPC peering);
 *  - a droplet with a profile that already exists: info (profile ignored: create-only);
 *  - a region with no tunnel: warning (no Cloudflare side).
 */
export function checkDesired(_desired: DesiredState): Diagnostic[] {
  return notImplemented("checks.checkDesired");
}

/**
 * Checks that compare the PR's head with its base (the current main), when the CLI gets --base:
 *  - a removed droplet file that another file still lists (error);
 *  - a removed droplet file: warning that its Cloudflare side (SSH route, site, monitors) will be
 *    deleted while the droplet keeps running (the tool never deletes droplets);
 *  - a changed profile on an existing droplet: info (create-only; nothing happens).
 */
export function checkChange(_base: InfraConfig, _head: InfraConfig): Diagnostic[] {
  return notImplemented("checks.checkChange");
}
