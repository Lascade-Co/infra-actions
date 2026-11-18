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

## How the plan reads (as built)

`planFirewall` compares, per droplet that exists or will be created, the rules its file implies with every inbound rule of every firewall attached to it today. A firewall is attached through the droplet's id, or through a tag the droplet carries. For a droplet still to be created, that means the tags it will get.

- **Exactly present:** the same protocol and ports, and the same source. The source is the same CIDR, or the caller's own droplet id. **Assumption, not confirmed in DigitalOcean's docs:** a droplet source admits all of that droplet's addresses (private and public), so it is the same access as the caller's IP. These rules are counted in `unchanged` and get no op.
- **Would allow** (`before: null`): a rule no firewall grants today. Key `"<droplet> inbound <protocol>/<ports> <source>"`. There is no firewall name yet, because Phase 5 hasn't decided how firewalls are laid out, so the callee droplet's name stands in for it.
- **Would narrow** (`before` = today's rule, `after` = the file rules it would be cut down to): today's rule grants a declared rule, but more as well. Examples: `0.0.0.0/0` where the file names one address, `all` ports, or a tag that covers other droplets too.
- **Would remove** (`after: null`): today's rule grants nothing any file declares.
- Narrow and remove keys are `"<firewall> inbound <protocol>/<ports> <source> on <droplet>"`. A tag-attached firewall shows up under each droplet it reaches.
- A declared rule that a rule which stays already grants is counted as `unchanged`.
- **Left out:** ICMP and outbound rules (the files can't declare them, so they are neither shown nor touched), and rules whose ports can't be read (`firewall-unreadable-rule` warning).
- **`firewall-undeclared` info:** "would remove" includes access the files can't declare yet. The main case is the tunnel connectors reaching SSH, web origins and `allow.tunnel` ports over the private network. Phase 5 has to account for those before it closes anything.
- **Pending ops:** ops of a droplet still to be created, and rules whose caller IP is `(known after create)`, carry `pending: true`.
- **Never throws:** callers with no file and droplets that are `missing` or `conflict` yield no rules. The checks and the desired state report them; this module doesn't repeat those diagnostics. Its only diagnostic of its own is `swarm-esp`, once per encrypted cluster.
- **`observeFirewalls`:** builds its DigitalOcean client with `allowWrites: false` in every mode, reads at most 50 pages of 200, and needs `DO_TOKEN`.

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
