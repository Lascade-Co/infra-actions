# firewall (B3): DigitalOcean firewall plan, REPORT-ONLY

The `allow:` and `swarm:` sections of the droplet files imply inbound firewall rules. This module shows how they differ from today's DigitalOcean firewalls. **It writes nothing until migration Phase 5 turns enforcement on, one firewall at a time.** Applying these rules early would close ports that callers still use.

## What it must do

- **`firewallRules(desired)`** (pure) lists every inbound rule the files imply:
  - **`allow.droplet[]`:** one rule per port. The source is the caller droplet's private IP when caller and callee share a region. In a different region it's the caller's public IP with `crossRegion: true`, flagged in the PR comment. A caller with `status: "create"` uses `KNOWN_AFTER_CREATE`.
  - **`allow.ip[]`:** one rule per port, with the CIDR as the source.
  - **`swarm:`:** rules between every pair of members of a cluster:
    - `2377/tcp` to managers;
    - `7946/tcp`, `7946/udp` and `4789/udp` between all members.
  - **`encrypted_overlay: true`:** this needs ESP (IP protocol 50), which a DigitalOcean cloud firewall cannot express (it only does tcp, udp and icmp). Return a warning diagnostic and no rule.
- **`planFirewall(desired, observed)`** (pure): diff those rules against the firewalls from `GET /v2/firewalls`. Today's firewalls are attached by tag (the old `production`/`staging`/`internal` tags) and by droplet id.
  - Show, per droplet, the rules it would gain and lose.
  - **Every op has `action: "report"`,** with `kind: "firewall"` or `"firewall-rule"`.
  - The `reason` says what would change and why (the file entry, its `note`).
  - Never emit create, update or delete.
- **`observeFirewalls(ctx)`:** read-only `GET /v2/firewalls` (all pages) through `ApiClient` with `DO_TOKEN`.
- **`applyFirewall(ops)`:** already written. It performs nothing and throws on any non-report op. Keep it that way until Phase 5. The DigitalOcean token has no firewall write scope until then anyway.

## Inputs and outputs

- **Input:** `DesiredState`. Each droplet's `spec.allow`, `spec.swarm`, `region`, `privateIpv4`/`publicIpv4` and `status` are in it.
- **Observed:** `FirewallObserved`.
- **Output:** `ModulePlan` with report ops only, plus diagnostics.

## Port from

Nothing in the Worker writes firewalls. For background, see:

- `firewalls.manual.json`;
- `server-to-server-map.md`;
- the Phase 5 section of `zero-trust-migration-plan.md`.

All three are in the audit folder and are **not** to be copied here: they hold real addresses. Tests go in `test/firewall/` and use fake data only.
