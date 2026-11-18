// B2: checks beyond the schema. See README.md in this folder.
//
// The loader (src/core/loader.ts) already did the single-file rules. These are the
// cross-file and account-dependent ones. All functions are pure and return diagnostics
// (code + file + path + droplet), never throw for a rule violation.

import type { DesiredDroplet, DesiredState } from "../core/desired.js";
import type { Diagnostic, Level } from "../core/diagnostics.js";
import { DROPLETS_DIR } from "../core/loader.js";
import type { DropletEntry, DropletFile, InfraConfig } from "../core/model.js";
import { flattenName, isOneLevel } from "../core/naming.js";
import { formatPort, formatWho } from "../core/values.js";

const fileOf = (name: string): string => `${DROPLETS_DIR}/${name}.yaml`;


/** A droplet file entry, a desired droplet, or a removed file: anything with a source file and a droplet name. */
type At = DropletEntry | DesiredDroplet | { source: string; name: string };

function diag(level: Level, code: string, at: At, path: string | undefined, message: string): Diagnostic {
  const droplet = "file" in at ? at.file.name : at.name;
  return { level, code, file: at.source, ...(path ? { path } : {}), droplet, message };
}

const listNames = (names: readonly string[]): string => names.join(", ");

// ---------------------------------------------------------------------------------------------
// checkConfig: offline
// ---------------------------------------------------------------------------------------------

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
export function checkConfig(config: InfraConfig): Diagnostic[] {
  const out: Diagnostic[] = [];
  const { account } = config;
  const zones = account.cloudflare.zones;
  const names = new Set(config.droplets.map((d) => d.file.name));

  // ---------- naming ----------
  const bySsh = new Map<string, string>();
  for (const e of config.droplets) {
    const f = flattenName(e.file.name, zones);
    if (!f.ok) {
      out.push(diag("error", "naming", e, "name", `${e.file.name}: ${f.reason} (zones: ${listNames(zones)}); the droplet gets no generated names`));
      continue;
    }
    const other = bySsh.get(f.sshHostname);
    if (other) {
      out.push(
        diag("error", "name-collision", e, "name", `${e.file.name} and ${other} both flatten to ${f.sshHostname} (and ${f.vpcHostname}); rename one of them`),
      );
    } else bySsh.set(f.sshHostname, e.file.name);
  }

  // ---------- hostnames and tunnel routes ----------
  // Every name a file claims: its own droplet name, its extra site hostnames, its tunnel routes.
  interface Claim {
    entry: DropletEntry;
    path: string;
    what: string;
  }
  const claims = new Map<string, Claim[]>();
  for (const e of config.droplets) claims.set(e.file.name, [{ entry: e, path: "name", what: "droplet name" }]);
  const claim = (host: string, c: Claim) => claims.set(host, [...(claims.get(host) ?? []), c]);
  const oneLevel = (e: DropletEntry, host: string, path: string, what: string) => {
    const f = flattenName(host, zones);
    if (!f.ok) {
      out.push(diag("error", "not-in-zone", e, path, `${what} ${host}: ${f.reason} (zones: ${listNames(zones)})`));
    } else if (!isOneLevel(host, zones)) {
      out.push(
        diag(
          "error",
          "not-one-level",
          e,
          path,
          `${what} ${host} is not a One-level name (directly under ${f.zone}); Cloudflare's free certificate covers only those. Use ${f.label}.${f.zone}`,
        ),
      );
    }
  };
  for (const e of config.droplets) {
    const spec = e.file;
    if (spec.web) {
      // The droplet's own name is a site hostname only when it has a web section; a naming error was reported above.
      if (flattenName(spec.name, zones).ok) oneLevel(e, spec.name, "name", "site hostname");
      spec.web.hostnames.forEach((h, i) => {
        const path = `web.hostnames[${i}]`;
        oneLevel(e, h, path, "site hostname");
        claim(h, { entry: e, path, what: "a site hostname" });
      });
    }
    spec.allow.tunnel.forEach((t, i) => {
      const path = `allow.tunnel[${i}].route`;
      oneLevel(e, t.route, path, "tunnel route");
      claim(t.route, { entry: e, path, what: "a tunnel route" });
    });
  }

  const where = (c: Claim) => `${c.entry.source} (${c.path})`;
  for (const [host, cs] of [...claims.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (cs.length < 2) continue;
    const owner = cs.find((c) => c.path === "name");
    for (const c of cs) {
      if (c === owner) continue; // a droplet's own name always wins
      const others = cs.filter((o) => o !== c);
      const msg = owner
        ? `${host} is the name of droplet ${owner.entry.file.name}; it can't also be ${c.what} here`
        : `${host} is claimed more than once (${others.map((o) => `${o.what} in ${where(o)}`).join(", ")}); a name can be served by one droplet only`;
      out.push(diag("error", "hostname-claimed", c.entry, c.path, msg));
    }
  }

  // ---------- references ----------
  const tokens = account.cloudflare.service_tokens;
  const known = Object.keys(tokens).sort();
  const tokenHint = known.length ? `known: ${listNames(known)}` : "account.yaml lists none";
  for (const e of config.droplets) {
    const spec = e.file;
    if (spec.profile !== undefined && !config.profiles[spec.profile]) {
      const have = Object.keys(config.profiles).sort();
      out.push(
        diag("error", "unknown-profile", e, "profile", `profile "${spec.profile}" does not exist in profiles/ (${have.length ? `available: ${listNames(have)}` : "there are none"})`),
      );
    }
    spec.allow.droplet.forEach((d, i) => {
      if (!names.has(d.from)) {
        out.push(
          diag(
            "error",
            "unknown-droplet",
            e,
            `allow.droplet[${i}].from`,
            `${d.from} has no droplet file (${fileOf(d.from)}); a caller must be a managed droplet (use allow.ip for an outside address)`,
          ),
        );
      }
    });
    spec.allow.tunnel.forEach((t, i) => {
      t.who.forEach((w, j) => {
        if (w.kind === "service-token" && !(w.name in tokens)) {
          out.push(
            diag("error", "unknown-service-token", e, `allow.tunnel[${i}].who[${j}]`, `service token "${w.name}" is not in account.yaml cloudflare.service_tokens (${tokenHint})`),
          );
        }
      });
    });
    spec.web?.exceptions.forEach((x, i) => {
      if (x.allow === "everyone") return;
      for (const name of x.allow.service_tokens ?? []) {
        if (!(name in tokens)) {
          out.push(
            diag(
              "error",
              "unknown-service-token",
              e,
              `web.exceptions[${i}].allow.service_tokens`,
              `service token "${name}" is not in account.yaml cloudflare.service_tokens (${tokenHint})`,
            ),
          );
        }
      }
    });

    // ---------- deploy ----------
    if (spec.deploy && spec.env && account.cloudflare.ci_deploy_tokens[spec.env].length === 0) {
      out.push(
        diag(
          "warning",
          "no-deploy-token",
          e,
          "deploy",
          `deploy: true, but account.yaml cloudflare.ci_deploy_tokens.${spec.env} is empty, so no CI token may SSH into this droplet`,
        ),
      );
    }

    // ---------- tunnel UDP ----------
    spec.allow.tunnel.forEach((t, i) => {
      if (t.port.protocol !== "udp") return;
      if (t.who.length > 0 && t.who.every((w) => w.kind === "staff")) return;
      out.push(
        diag(
          "error",
          "udp-needs-staff",
          e,
          `allow.tunnel[${i}].port`,
          `${formatPort(t.port)} is UDP, which is only allowed with who: [staff] (got [${t.who.map(formatWho).join(", ")}]). ` +
            "Service tokens are TCP only (cloudflared access tcp); UDP reaches a droplet only through the Cloudflare One client's private-network route, which only staff have",
        ),
      );
    });
  }

  // ---------- swarm ----------
  for (const [cluster, members] of swarmClusters(config.droplets.map((e) => ({ entry: e, spec: e.file })))) {
    const entries = members.map((m) => m.entry);
    if (!members.some((m) => m.spec.swarm!.role === "manager")) {
      for (const e of entries) {
        out.push(
          diag(
            "error",
            "swarm-no-manager",
            e,
            "swarm.role",
            `swarm cluster "${cluster}" has no manager (members: ${listNames(entries.map((x) => x.file.name))}); set role: manager on at least one`,
          ),
        );
      }
    }
    const on = entries.filter((e) => e.file.swarm!.encrypted_overlay);
    const off = entries.filter((e) => !e.file.swarm!.encrypted_overlay);
    if (on.length && off.length) {
      const msg = `swarm cluster "${cluster}" members disagree on encrypted_overlay: true in ${listNames(on.map((x) => x.file.name))}; false in ${listNames(off.map((x) => x.file.name))}. All members must set the same value`;
      // Reported on the minority side (on a tie, on the files that say true).
      for (const e of on.length <= off.length ? on : off) out.push(diag("error", "swarm-overlay-mismatch", e, "swarm.encrypted_overlay", msg));
    }
  }

  return out;
}

function swarmClusters<T extends { spec: DropletFile }>(items: readonly T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    if (!it.spec.swarm) continue;
    m.set(it.spec.swarm.cluster, [...(m.get(it.spec.swarm.cluster) ?? []), it]);
  }
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------------------------
// checkDesired: needs the observed droplets
// ---------------------------------------------------------------------------------------------

const placed = (d: DesiredDroplet): boolean => d.status === "exists" || d.status === "create";

/**
 * Checks that need the observed droplets (after the join in core/desired.ts):
 *  - swarm members are in one region (error);
 *  - allow.droplet across regions: warning (the caller's PUBLIC IP will be allowed, no VPC peering);
 *  - a droplet with a profile that already exists: info (profile ignored: create-only);
 *  - a region with no tunnel: warning (no Cloudflare side).
 * A swarm member's advertise address can't be seen through the API, so it isn't checked here.
 */
export function checkDesired(desired: DesiredState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byName = new Map(desired.droplets.map((d) => [d.name, d]));

  for (const d of desired.droplets) {
    // ---------- profile on an existing droplet ----------
    if (d.status === "exists" && d.spec.profile) {
      out.push(
        diag(
          "info",
          "profile-ignored",
          d,
          "profile",
          `${d.name} already exists, so profile "${d.spec.profile}" is ignored: droplets are create-only (never resized or rebuilt)`,
        ),
      );
    }

    // ---------- region without a tunnel ----------
    if (placed(d) && d.region && !d.tunnelId) {
      out.push(
        diag(
          "warning",
          "region-without-tunnel",
          d,
          d.status === "create" ? "env" : undefined,
          `${d.name} is in region ${d.region}, which has no tunnel in account.yaml cloudflare.tunnels: it gets no Cloudflare side (no SSH route, site or tunnel routes)`,
        ),
      );
    }

    // ---------- allow.droplet across regions ----------
    if (!placed(d) || !d.region) continue;
    d.spec.allow.droplet.forEach((a, i) => {
      const caller = byName.get(a.from);
      if (!caller || !placed(caller) || !caller.region || caller.region === d.region) return;
      const ip = caller.publicIpv4 ?? (caller.status === "create" ? "known after create" : "not known yet");
      out.push(
        diag(
          "warning",
          "cross-region-caller",
          d,
          `allow.droplet[${i}].from`,
          `${a.from} is in ${caller.region} and ${d.name} is in ${d.region}: there is no VPC peering, so the firewall rule will allow ${a.from}'s PUBLIC IP (${ip}) ` +
            `on ${a.ports.map(formatPort).join(", ")}, and the traffic crosses the internet`,
        ),
      );
    });
  }

  // ---------- swarm: one region ----------
  for (const [cluster, members] of swarmClusters(desired.droplets.filter((d) => placed(d) && d.region))) {
    const regions = new Map<string, string[]>();
    for (const m of members) regions.set(m.region!, [...(regions.get(m.region!) ?? []), m.name]);
    if (regions.size < 2) continue;
    const sorted = [...regions.entries()].sort(([ra, a], [rb, b]) => b.length - a.length || ra.localeCompare(rb));
    const summary = sorted.map(([r, ns]) => `${r} (${listNames(ns)})`).join("; ");
    const main = sorted[0]![0];
    for (const m of members) {
      if (m.region === main) continue;
      out.push(
        diag(
          "error",
          "swarm-region",
          m,
          "swarm.cluster",
          `swarm cluster "${cluster}" spans regions ${summary}; all members must share one region (swarm traffic uses private IPs, and there is no VPC peering)`,
        ),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// checkChange: head vs base (check --base)
// ---------------------------------------------------------------------------------------------

/**
 * Checks that compare the PR's head with its base (the current main), when the CLI gets --base.
 * `desired` is the head's desired state (it holds the observed droplets); undefined when the
 * droplets could not be read.
 *  - a removed droplet file whose droplet still exists in DigitalOcean (error, decision 15:
 *    delete the droplet by hand first, then remove its file); without observed droplets the
 *    removal can't be confirmed (error);
 *  - a removed droplet file that another file still lists in allow.droplet (error);
 *  - a removed droplet file whose droplet is gone: warning that its Cloudflare side (SSH route,
 *    private name, site, tunnel routes), monitors and ssh config entry will be deleted;
 *  - a changed profile on an existing droplet: info (create-only; nothing happens).
 */
export function checkChange(base: InfraConfig, head: InfraConfig, desired?: DesiredState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const headByName = new Map(head.droplets.map((e) => [e.file.name, e]));

  for (const b of base.droplets) {
    const name = b.file.name;
    const h = headByName.get(name);
    if (h) {
      // ---------- changed profile ----------
      if (b.file.profile !== h.file.profile && desired) {
        const d = desired.droplets.find((x) => x.name === name);
        if (d?.status === "exists") {
          out.push(
            diag(
              "info",
              "profile-changed",
              h,
              "profile",
              `profile changed from ${b.file.profile ?? "(none)"} to ${h.file.profile ?? "(none)"}, but ${name} already exists: droplets are create-only, so nothing changes`,
            ),
          );
        }
      }
      continue;
    }

    // ---------- removed file ----------
    const removed = { source: b.source, name };
    const referrers: string[] = [];
    for (const e of head.droplets) {
      e.file.allow.droplet.forEach((a, i) => {
        if (a.from === name) referrers.push(`${e.source} allow.droplet[${i}].from`);
      });
    }
    if (referrers.length) {
      out.push(
        diag(
          "error",
          "removed-droplet-referenced",
          removed,
          undefined,
          `${b.source} is removed, but other files still list ${name} as a caller: ${listNames(referrers)}. Remove those entries in the same pull request`,
        ),
      );
    }

    if (!desired) {
      out.push(
        diag(
          "error",
          "removed-droplet-unverified",
          removed,
          undefined,
          `${b.source} is removed, but the droplets could not be read to confirm that ${name} no longer exists. A droplet file may only be removed after its droplet is deleted`,
        ),
      );
      continue;
    }
    const live = desired.unmanaged.filter((d) => d.name === name);
    if (live.length) {
      out.push(
        diag(
          "error",
          "removed-droplet-exists",
          removed,
          undefined,
          `${b.source} is removed, but droplet ${name} (${live.map((d) => `id ${d.id}, ${d.region}`).join("; ")}) still exists in DigitalOcean. ` +
            "The tool never deletes droplets: to retire it, delete the droplet by hand first, then remove its file. " +
            "To keep it, restore the file",
        ),
      );
    } else {
      out.push(
        diag(
          "warning",
          "droplet-file-removed",
          removed,
          undefined,
          `${b.source} is removed and droplet ${name} no longer exists: merging deletes its Cloudflare side (SSH route, private name, site, tunnel routes, Access apps), ` +
            "and its ssh config entry. Its monitors are listed in the plan for removal by hand (the tool never deletes monitors)",
        ),
      );
    }
  }
  return out;
}
