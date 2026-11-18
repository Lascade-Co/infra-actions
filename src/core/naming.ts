// Pure: droplet name -> zone, Flattened label, SSH route and Private name.
// Ported unchanged in behaviour from infra-sync src/naming.ts.
//
//   staging.app.example.com -> ssh-staging-app.example.com, vpc-staging-app.example.com
//   app.example.com         -> ssh-app.example.com,         vpc-app.example.com
//   build-box               -> not a domain in an account zone (reported, never guessed)

import { SSH_PREFIX, VPC_PREFIX } from "./constants.js";

export type FlattenResult =
  | { ok: true; zone: string; label: string; sshHostname: string; vpcHostname: string }
  | { ok: false; reason: string };

const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A lowercase domain: what a droplet name, a site hostname and a tunnel route must look like. */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function flattenName(name: string, zoneNames: readonly string[]): FlattenResult {
  if (name !== name.toLowerCase()) {
    return { ok: false, reason: "name has uppercase letters; droplet names must be lowercase domains" };
  }
  if (!/^[a-z0-9.-]+$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.includes("..")) {
    return { ok: false, reason: "name is not a valid domain name" };
  }
  // Longest zone suffix, matched on a dot boundary ("notexample.com" does not match "example.com").
  let zone: string | undefined;
  for (const z of zoneNames) {
    const zl = z.toLowerCase();
    if (name.endsWith("." + zl) && (!zone || zl.length > zone.length)) zone = zl;
  }
  if (!zone) {
    if (zoneNames.some((z) => name === z.toLowerCase())) {
      return { ok: false, reason: "name is a zone apex; it needs a label under the zone" };
    }
    return { ok: false, reason: "name is not a domain in any account zone" };
  }
  const rest = name.slice(0, name.length - zone.length - 1);
  const parts = rest.split(".");
  if (parts.some((p) => !DNS_LABEL_RE.test(p))) {
    return { ok: false, reason: "name has an invalid DNS label" };
  }
  const label = parts.join("-");
  const sshLabel = `${SSH_PREFIX}${label}`;
  if (sshLabel.length > 63) {
    return { ok: false, reason: `flattened label "${sshLabel}" is longer than 63 characters` };
  }
  // "vpc-" is as long as "ssh-", so the 63-character check above covers it too.
  return { ok: true, zone, label, sshHostname: `${sshLabel}.${zone}`, vpcHostname: `${VPC_PREFIX}${label}.${zone}` };
}

/** A One-level name: directly under its zone (the only kind the free certificate covers). */
export function isOneLevel(hostname: string, zoneNames: readonly string[]): boolean {
  const f = flattenName(hostname, zoneNames);
  return f.ok && !hostname.slice(0, hostname.length - f.zone.length - 1).includes(".");
}
