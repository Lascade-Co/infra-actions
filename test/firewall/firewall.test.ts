// Fake data only: example.com names, RFC 5737 / 10.0.0.x addresses, invented firewall names.

import { describe, expect, it } from "vitest";
import { KNOWN_AFTER_CREATE } from "../../src/core/constants.js";
import { buildDesired, type DesiredState } from "../../src/core/desired.js";
import { loadInfraFiles } from "../../src/core/loader.js";
import type { ObservedDroplet } from "../../src/core/observed.js";
import type { RunContext } from "../../src/core/plan.js";
import { Secrets } from "../../src/core/secrets.js";
import {
  applyFirewall,
  cidrContains,
  type DoFirewall,
  firewallRules,
  observeFirewalls,
  parseDoPorts,
  planFirewall,
  sourceText,
} from "../../src/firewall/index.js";
import { exampleWith, observedDroplet } from "../helpers.js";

const EXISTING: ObservedDroplet[] = [
  observedDroplet("db.example.com", { id: 1, privateIpv4: "10.0.0.11", publicIpv4: "203.0.113.11", tags: ["old-db"] }),
  observedDroplet("shop.example.com", { id: 2, privateIpv4: "10.0.0.12", publicIpv4: "203.0.113.12", tags: ["old-web", "env-prod"] }),
  observedDroplet("worker.example.com", { id: 3, privateIpv4: "10.0.0.13", publicIpv4: "203.0.113.13", tags: ["old-web"] }),
  observedDroplet("tools.example.net", { id: 4, region: "blr1", privateIpv4: "10.0.0.14", publicIpv4: "198.51.100.14" }),
  observedDroplet("legacy-box", { id: 9, privateIpv4: "10.0.0.19", tags: ["old-web"] }),
];

async function desired(changes: Record<string, string | null> = {}, observed = EXISTING): Promise<DesiredState> {
  const r = loadInfraFiles(await exampleWith(changes));
  if (!r.config) throw new Error(`fixture does not load: ${JSON.stringify(r.diagnostics)}`);
  return buildDesired(r.config, observed);
}

const fw = (over: Partial<DoFirewall> & Pick<DoFirewall, "name" | "inbound_rules">): DoFirewall => ({
  id: `00000000-0000-4000-8000-${String(over.name.length).padStart(12, "0")}`,
  droplet_ids: [],
  tags: [],
  outbound_rules: [],
  ...over,
});

const short = (rs: ReturnType<typeof firewallRules>["rules"]) => rs.map((r) => `${r.droplet} ${r.protocol}/${r.ports} ${sourceText(r.source)} ${r.origin}${r.crossRegion ? " cross" : ""}`);

describe("firewallRules", () => {
  it("derives allow.droplet (private IP in-region), allow.ip and swarm all-pairs rules", async () => {
    const { rules, diagnostics } = firewallRules(await desired());
    expect(diagnostics).toEqual([]);
    expect(short(rules)).toEqual([
      "db.example.com tcp/5432 10.0.0.12/32 allow.droplet",
      "db.example.com tcp/5432 10.0.0.13/32 allow.droplet",
      "db.example.com tcp/9000-9001 10.0.0.13/32 allow.droplet",
      "db.example.com tcp/5432 192.0.2.10/32 allow.ip",
      "shop.example.com tcp/8080 10.0.0.13/32 allow.droplet",
      // worker-2 is still to be created: its private IP is known after create.
      `worker-2.example.com tcp/7946 10.0.0.13/32 swarm`,
      `worker-2.example.com udp/7946 10.0.0.13/32 swarm`,
      `worker-2.example.com udp/4789 10.0.0.13/32 swarm`,
      `worker.example.com tcp/2377 worker-2.example.com private IP ${KNOWN_AFTER_CREATE} swarm`,
      `worker.example.com tcp/7946 worker-2.example.com private IP ${KNOWN_AFTER_CREATE} swarm`,
      `worker.example.com udp/7946 worker-2.example.com private IP ${KNOWN_AFTER_CREATE} swarm`,
      `worker.example.com udp/4789 worker-2.example.com private IP ${KNOWN_AFTER_CREATE} swarm`,
    ]);
    expect(rules.find((r) => r.origin === "allow.ip")!.note).toBe("office backup box with a fixed address and no cloudflared");
  });

  it("uses the caller's public IP across regions and flags it", async () => {
    const { rules } = firewallRules(
      await desired({ "droplets/db.example.com.yaml": "name: db.example.com\nallow:\n  droplet:\n    - from: tools.example.net\n      ports: [5432/tcp]\n" }),
    );
    expect(rules.filter((r) => r.droplet === "db.example.com")).toEqual([
      {
        droplet: "db.example.com",
        protocol: "tcp",
        ports: "5432",
        source: { kind: "droplet", name: "tools.example.net", address: "198.51.100.14", addressKind: "public" },
        origin: "allow.droplet",
        crossRegion: true,
      },
    ]);
  });

  it("warns once per cluster that ESP can't be expressed, and makes no rule for it", async () => {
    const { rules, diagnostics } = firewallRules(
      await desired({
        "droplets/worker.example.com.yaml": "name: worker.example.com\nenv: prod\nswarm:\n  cluster: jobs\n  role: manager\n  encrypted_overlay: true\n",
        "droplets/worker-2.example.com.yaml": "name: worker-2.example.com\nprofile: ubuntu-4\nenv: prod\nswarm:\n  cluster: jobs\n  encrypted_overlay: true\n",
      }),
    );
    expect(diagnostics.map((d) => [d.level, d.code, d.file, d.path])).toEqual([["warning", "swarm-esp", "droplets/worker-2.example.com.yaml", "swarm.encrypted_overlay"]]);
    expect(diagnostics[0]!.message).toContain("ESP (IP protocol 50)");
    expect(rules.every((r) => r.protocol === "tcp" || r.protocol === "udp")).toBe(true);
  });

  it("keeps a rule implied by both swarm and allow.droplet once", async () => {
    const { rules } = firewallRules(
      await desired({
        "droplets/worker.example.com.yaml": "name: worker.example.com\nenv: prod\nswarm:\n  cluster: jobs\n  role: manager\n",
        "droplets/worker-2.example.com.yaml":
          "name: worker-2.example.com\nprofile: ubuntu-4\nenv: prod\nswarm:\n  cluster: jobs\nallow:\n  droplet:\n    - from: worker.example.com\n      ports: [7946/tcp]\n      note: gossip\n",
      }),
    );
    const gossip = rules.filter((r) => r.droplet === "worker-2.example.com" && r.protocol === "tcp" && r.ports === "7946");
    expect(gossip).toHaveLength(1);
    expect(gossip[0]!.origin).toBe("allow.droplet");
  });

  it("never throws: skips unknown callers and droplets that are missing", async () => {
    const d = await desired(
      { "droplets/db.example.com.yaml": "name: db.example.com\nallow:\n  droplet:\n    - from: ghost.example.com\n      ports: [5432/tcp]\n    - from: shop.example.com\n      ports: [5432/tcp]\n" },
      EXISTING.filter((x) => x.name !== "shop.example.com"),
    );
    // shop is missing (no droplet, no profile); ghost has no file. Neither yields a rule; shop's own rules are gone too.
    expect(short(firewallRules(d).rules).filter((r) => r.startsWith("db.") || r.startsWith("shop."))).toEqual([]);
  });
});

describe("planFirewall (report-only)", () => {
  it("with no firewalls today, every implied rule is a report op 'would allow'", async () => {
    const plan = planFirewall(await desired(), { firewalls: [] });
    expect(plan.module).toBe("firewall");
    expect(plan.unchanged).toBe(0);
    expect(plan.ops).toHaveLength(12);
    expect(new Set(plan.ops.map((o) => o.action))).toEqual(new Set(["report"]));
    expect(new Set(plan.ops.map((o) => o.kind))).toEqual(new Set(["firewall-rule"]));
    const shop = plan.ops.find((o) => o.droplet === "shop.example.com")!;
    expect(shop).toMatchObject({
      provider: "digitalocean",
      key: "shop.example.com inbound tcp/8080 10.0.0.13/32",
      before: null,
      after: { protocol: "tcp", ports: "8080", source: "10.0.0.13/32", caller: "worker.example.com", address_kind: "private" },
      reason: 'would allow tcp/8080 from worker.example.com private IP 10.0.0.13 (allow.droplet "queue worker calls the internal API") (not allowed today)',
    });
    expect(shop.pending).toBeUndefined();
    // A new droplet's ops wait for it; so do rules whose caller has no IP yet.
    expect(plan.ops.filter((o) => o.pending).map((o) => o.droplet)).toEqual([...Array(3).fill("worker-2.example.com"), ...Array(4).fill("worker.example.com")]);
    expect(new Set(plan.ops.map((o) => o.key)).size).toBe(plan.ops.length);
  });

  it("flags cross-region callers in the reason", async () => {
    const plan = planFirewall(
      await desired({ "droplets/db.example.com.yaml": "name: db.example.com\nallow:\n  droplet:\n    - from: tools.example.net\n      ports: [5432/tcp]\n" }),
      { firewalls: [] },
    );
    const op = plan.ops.find((o) => o.droplet === "db.example.com")!;
    expect(op.reason).toContain("tools.example.net public IP 198.51.100.14");
    expect(op.reason).toContain("other region, no VPC peering, so the caller's PUBLIC IP");
    expect(op.after).toMatchObject({ cross_region: true });
  });

  it("shows per droplet what Phase 5 would keep, narrow and remove", async () => {
    const firewalls: DoFirewall[] = [
      fw({
        name: "fw-db",
        droplet_ids: [1],
        inbound_rules: [
          { protocol: "tcp", ports: "5432", sources: { addresses: ["10.0.0.12", "0.0.0.0/0", "::/0"], droplet_ids: [3] } },
          { protocol: "tcp", ports: "22", sources: { addresses: ["198.51.100.0/24"] } },
          { protocol: "icmp", ports: "0", sources: { addresses: ["0.0.0.0/0"] } },
        ],
      }),
      fw({
        name: "fw-web",
        tags: ["old-web"],
        inbound_rules: [
          { protocol: "tcp", ports: "all", sources: { tags: ["old-web"] } },
          { protocol: "tcp", ports: "443", sources: { addresses: ["0.0.0.0/0"], load_balancer_uids: ["00000000-0000-4000-8000-0000000000aa"] } },
        ],
      }),
      fw({ name: "fw-unrelated", droplet_ids: [4], inbound_rules: [{ protocol: "tcp", ports: "8000", sources: { addresses: ["192.0.2.50"] } }] }),
    ];
    const plan = planFirewall(await desired(), { firewalls });
    const of = (droplet: string) => plan.ops.filter((o) => o.droplet === droplet).map((o) => o.key);

    // db: 5432 from shop (address) and from worker (droplet id) are kept; 9000-9001 from worker is
    // new; the office box is only allowed through 0.0.0.0/0 today, so that rule narrows; ::/0 and 22 go.
    expect(of("db.example.com")).toEqual([
      "db.example.com inbound tcp/9000-9001 10.0.0.13/32",
      "fw-db inbound tcp/5432 0.0.0.0/0 on db.example.com",
      "fw-db inbound tcp/5432 ::/0 on db.example.com",
      "fw-db inbound tcp/22 198.51.100.0/24 on db.example.com",
    ]);
    const narrow = plan.ops.find((o) => o.key === "fw-db inbound tcp/5432 0.0.0.0/0 on db.example.com")!;
    expect(narrow.after).toEqual([{ protocol: "tcp", ports: "5432", source: "192.0.2.10/32" }]);
    expect(narrow.reason).toBe(
      'would narrow: today firewall fw-db (attached by droplet id) allows tcp/5432 from 0.0.0.0/0 (anywhere); the droplet files only ask for tcp/5432 from 192.0.2.10/32 (allow.ip "office backup box with a fixed address and no cloudflared")',
    );
    const ssh = plan.ops.find((o) => o.key === "fw-db inbound tcp/22 198.51.100.0/24 on db.example.com")!;
    expect(ssh).toMatchObject({ after: null, before: { firewall: "fw-db", attached_by: "droplet id", protocol: "tcp", ports: "22", source: "198.51.100.0/24" } });
    expect(ssh.reason).toBe("would remove: today firewall fw-db (attached by droplet id) allows tcp/22 from 198.51.100.0/24, which no droplet file declares");

    // shop (tag old-web): 8080 from worker is granted today by the tag rule (all ports), which
    // would narrow to that one rule; 443 from anywhere and from the load balancer go.
    expect(of("shop.example.com")).toEqual([
      "fw-web inbound tcp/all tag:old-web on shop.example.com",
      "fw-web inbound tcp/443 0.0.0.0/0 on shop.example.com",
      "fw-web inbound tcp/443 load-balancer:00000000-0000-4000-8000-0000000000aa on shop.example.com",
    ]);
    const tag = plan.ops.find((o) => o.key === "fw-web inbound tcp/all tag:old-web on shop.example.com")!;
    expect(tag.before).toMatchObject({ attached_by: "tag old-web", tag_members: ["legacy-box", "shop.example.com", "worker.example.com"] });
    expect(tag.reason).toContain("allows tcp/all from tag old-web (legacy-box, shop.example.com, worker.example.com)");
    expect(tag.reason).toContain("only ask for tcp/8080 from worker.example.com private IP 10.0.0.13");

    expect(plan.unchanged).toBe(2);
    expect(plan.ops.every((o) => o.action === "report")).toBe(true);
    expect(plan.diagnostics.map((d) => d.code)).toEqual(["firewall-undeclared"]);
    expect(plan.diagnostics[0]!.message).toContain("tunnel connectors");
    // Nothing about the unrelated droplet's firewall leaks into other droplets.
    expect(plan.ops.some((o) => o.key.startsWith("fw-unrelated") && o.droplet !== "tools.example.net")).toBe(false);
  });

  it("counts a rule already granted by a kept rule as unchanged", async () => {
    const plan = planFirewall(await desired({ "droplets/db.example.com.yaml": "name: db.example.com\nallow:\n  ip:\n    - from: 0.0.0.0/0\n      ports: [5432/tcp]\n  droplet:\n    - from: shop.example.com\n      ports: [5432/tcp]\n" }), {
      firewalls: [fw({ name: "fw-db", droplet_ids: [1], inbound_rules: [{ protocol: "tcp", ports: "5432", sources: { addresses: ["0.0.0.0/0"] } }] })],
    });
    expect(plan.ops.filter((o) => o.droplet === "db.example.com")).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it("attaches tag firewalls to a droplet still to be created by the tags it will get", async () => {
    const plan = planFirewall(await desired(), {
      firewalls: [fw({ name: "fw-env", tags: ["env-staging"], inbound_rules: [{ protocol: "tcp", ports: "80", sources: { addresses: ["0.0.0.0/0"] } }] })],
    });
    expect(plan.ops.filter((o) => o.droplet === "staging-shop.example.com")).toEqual([
      expect.objectContaining({ key: "fw-env inbound tcp/80 0.0.0.0/0 on staging-shop.example.com", action: "report", pending: true }),
    ]);
  });

  it("warns about rules whose ports it can't read and leaves them out", async () => {
    const plan = planFirewall(await desired(), {
      firewalls: [fw({ name: "fw-odd", droplet_ids: [2], inbound_rules: [{ protocol: "tcp", ports: "80,443", sources: { addresses: ["0.0.0.0/0"] } }] })],
    });
    expect(plan.diagnostics.map((d) => [d.code, d.message])).toEqual([["firewall-unreadable-rule", "firewall rule fw-odd tcp/80,443 has ports the tool can't read; it is left out of the plan"]]);
  });

  it("produces ops that applyFirewall only ever skips", async () => {
    const plan = planFirewall(await desired(), { firewalls: [] });
    const res = await applyFirewall(plan.ops);
    expect(res.applied).toEqual([]);
    expect(res.skipped).toHaveLength(plan.ops.length);
    await expect(applyFirewall([{ ...plan.ops[0]!, action: "create" }])).rejects.toThrow("report-only until migration Phase 5");
    await expect(applyFirewall([{ ...plan.ops[0]!, action: "delete" }])).rejects.toThrow("refusing delete");
  });
});

describe("helpers", () => {
  it("parses DigitalOcean port strings", () => {
    expect(parseDoPorts("8443")).toEqual({ from: 8443, to: 8443 });
    expect(parseDoPorts("8000-8010")).toEqual({ from: 8000, to: 8010 });
    expect(parseDoPorts("all")).toEqual({ from: 1, to: 65535 });
    expect(parseDoPorts("0")).toEqual({ from: 1, to: 65535 });
    expect(parseDoPorts("80,443")).toBeUndefined();
    expect(parseDoPorts("9-1")).toBeUndefined();
  });

  it("compares CIDRs", () => {
    expect(cidrContains("0.0.0.0/0", "192.0.2.10/32")).toBe(true);
    expect(cidrContains("192.0.2.0/24", "192.0.2.10/32")).toBe(true);
    expect(cidrContains("192.0.2.0/24", "198.51.100.1/32")).toBe(false);
    expect(cidrContains("192.0.2.10/32", "192.0.2.0/24")).toBe(false);
    expect(cidrContains("::/0", "2001:db8::1/128")).toBe(true);
    expect(cidrContains("::/0", "192.0.2.1/32")).toBe(false);
  });
});

describe("observeFirewalls", () => {
  const ctx = (fetch: RunContext["fetch"], env: Record<string, string> = { DO_TOKEN: "do-test-token-0001" }, mode: RunContext["mode"] = "check"): RunContext => ({
      mode,
      account: undefined as unknown as RunContext["account"],
      secrets: new Secrets(env),
      fetch,
      allowWrites: mode === "apply",
      now: () => new Date(0),
      sleep: async () => {},
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("reads every page with GET and the DO token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const pages = [
      { firewalls: [{ id: "a", name: "fw-a", droplet_ids: [1], tags: [], inbound_rules: [{ protocol: "tcp", ports: "22", sources: { addresses: ["192.0.2.1"] } }], outbound_rules: [] }], links: { pages: { next: "p2" } } },
      { firewalls: [{ id: "b", name: "fw-b", tags: ["old-web"] }], links: { pages: {} } },
    ];
    const res = await observeFirewalls(
      ctx(async (url, init) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return json(pages[calls.length - 1]);
      }, undefined, "apply"),
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.digitalocean.com/v2/firewalls?page=1&per_page=200",
      "https://api.digitalocean.com/v2/firewalls?page=2&per_page=200",
    ]);
    expect(calls.every((c) => c.init?.method === "GET")).toBe(true);
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer do-test-token-0001");
    expect(res.firewalls.map((f) => f.name)).toEqual(["fw-a", "fw-b"]);
    expect(res.firewalls[1]).toEqual({ id: "b", name: "fw-b", droplet_ids: [], tags: ["old-web"], inbound_rules: [], outbound_rules: [] });
  });

  it("needs DO_TOKEN and stops after a bounded number of pages", async () => {
    await expect(observeFirewalls(ctx(async () => json({ firewalls: [] }), {}))).rejects.toThrow("DO_TOKEN is not set");
    let n = 0;
    await expect(
      observeFirewalls(
        ctx(async () => {
          n++;
          return json({ firewalls: [], links: { pages: { next: "more" } } });
        }),
      ),
    ).rejects.toThrow("more than 50 pages");
    expect(n).toBe(50);
  });

  it("surfaces API errors without the token", async () => {
    const err = await observeFirewalls(ctx(async () => new Response(JSON.stringify({ message: "Unable to authenticate you" }), { status: 401 }))).catch((e: Error) => e);
    expect(String(err)).toContain("digitalocean GET /v2/firewalls: HTTP 401");
    expect(String(err)).not.toContain("do-test-token-0001");
  });
});
