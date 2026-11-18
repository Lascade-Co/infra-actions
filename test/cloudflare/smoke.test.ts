import { describe, expect, it } from "vitest";
import { changes, exampleFixture, idx, isAppPost, isDnsPost, isTargetPost, isTunnelPutWith, planOnly, run, STAGING_TOKEN, T_BLR1, T_NYC1, Z_COM } from "./fake.js";

describe("first run against the example fixture", () => {
  it("creates target -> app -> ingress -> DNS in order and reports unmanageable droplets", async () => {
    const f = exampleFixture();
    const r = await run(f);
    expect(r.errors).toEqual([]);
    expect(r.result.failed).toEqual([]);
    const w = f.writes();

    for (const [name, host, tid] of [
      ["staging.esim.example.com", "ssh-staging-esim.example.com", T_BLR1],
      ["click.example.com", "ssh-click.example.com", T_NYC1],
    ] as const) {
      const t = idx(w, isTargetPost(name));
      const a = idx(w, isAppPost(host));
      const i = idx(w, isTunnelPutWith(tid, host));
      const d = idx(w, isDnsPost(host));
      expect([t, a, i, d].every((x) => x >= 0)).toBe(true);
      expect(t).toBeLessThan(a);
      expect(a).toBeLessThan(i);
      expect(i).toBeLessThan(d);
    }

    expect(f.targets.find((t) => t.hostname === "click.example.com")).toMatchObject({ ip: { ipv4: { ip_addr: "10.0.0.3" } }, tags: { "managed-by": "infra-sync" } });
    expect(f.targets[0]!.ip.ipv4).not.toHaveProperty("virtual_network_id");

    const esimApp = f.apps.find((a) => a.domain === "ssh-staging-esim.example.com")!;
    expect(esimApp.name).toBe("infra-sync: ssh-staging-esim.example.com");
    expect(esimApp.policies?.map((p) => p.decision)).toEqual(["non_identity", "allow"]);
    expect(esimApp.policies?.[0]!.include).toEqual([{ service_token: { token_id: STAGING_TOKEN } }]);
    expect(esimApp.policies?.[1]!.include).toEqual([{ email: { email: "admin@example.com" } }, { email: { email: "ops@example.com" } }]);

    expect(f.tunnels[T_BLR1]!.config).toEqual({
      ingress: [
        { hostname: "manual-dashboard.example.com", service: "https://10.0.1.13:443", originRequest: { originServerName: "dashboard.internal.example.com" } },
        { hostname: "ssh-staging-esim.example.com", service: "ssh://10.0.1.5:22" },
        { service: "http_status:404" },
      ],
      "warp-routing": { enabled: true },
    });
    expect(f.dns[Z_COM]!.find((r) => r.name === "ssh-click.example.com")).toMatchObject({ type: "CNAME", content: `${T_NYC1}.cfargotunnel.com`, proxied: true, comment: "managed-by:infra-sync" });
    expect(r.warnings.some((w) => /old\.example\.com: region "ams3"/.test(w))).toBe(true);
  });

  it("is idempotent: a second plan has no changes", async () => {
    const f = exampleFixture();
    await run(f);
    const p = await planOnly(f);
    expect(changes(p)).toEqual([]);
    expect(p.unchanged).toBeGreaterThan(0);
  });
});
