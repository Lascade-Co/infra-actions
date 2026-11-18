import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { readSchema, validate } from "../../src/core/schema.js";
import { exampleFiles } from "../helpers.js";

describe("schemas", () => {
  it("every example file is valid against its schema", async () => {
    const files = await exampleFiles();
    let n = 0;
    for (const [path, text] of Object.entries(files)) {
      const kind = path === "account.yaml" ? "account" : path.startsWith("droplets/") ? "droplet" : /^profiles\/[^/]+\.yaml$/.test(path) ? "profile" : undefined;
      if (!kind) continue;
      expect(validate(kind, parse(text)), path).toEqual([]);
      n++;
    }
    expect(n).toBe(9); // account + 2 profiles + 6 droplets
  });

  // The TypeScript model (src/core/model.ts) mirrors the schemas. When a key is added to one,
  // this test fails until the other (and this list) is updated too.
  it("droplet file keys match the TypeScript model", () => {
    const s = readSchema("droplet") as { properties: Record<string, unknown>; definitions: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(s.properties).sort()).toEqual(
      ["allow", "deploy", "description", "env", "frozen", "monitors", "name", "profile", "swarm", "web"].sort(),
    );
    expect(Object.keys(s.definitions.web!.properties!).sort()).toEqual(
      ["exceptions", "exposure", "health_accept_app_404", "health_path", "hostnames", "origin", "protected_paths"].sort(),
    );
    expect(Object.keys(s.definitions.allow!.properties!).sort()).toEqual(["droplet", "ip", "tunnel"]);
    expect(Object.keys(s.definitions.swarm!.properties!).sort()).toEqual(["cluster", "encrypted_overlay", "role"]);
    expect(Object.keys(s.definitions.monitor!.properties!).sort()).toEqual(["accept_app_404", "hostname", "path", "type"]);
  });

  it("account keys match the TypeScript model", () => {
    const s = readSchema("account") as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(s.properties).sort()).toEqual(["cloudflare", "digitalocean", "github", "oneuptime", "ssh_config", "telegram"]);
    expect(Object.keys(s.properties.cloudflare!.properties!).sort()).toEqual(
      ["account_id", "ci_deploy_tokens", "guards", "service_tokens", "ssh_admin_emails", "staff_policy_id", "team_domain", "tunnels", "zones"].sort(),
    );
  });

  it("rejects unknown keys at every level", () => {
    expect(validate("droplet", { name: "x.example.com", tags: ["web-staff"] })).toEqual([
      { segments: ["tags"], path: "tags", message: 'unknown key "tags"' },
    ]);
    expect(validate("profile", { name: "p", size: "s", image: "i", user_data: "u", region: "nyc1" })).toEqual([
      { segments: ["region"], path: "region", message: 'unknown key "region"' },
    ]);
  });

  it("reports every problem at once, with dotted paths", () => {
    const issues = validate("droplet", {
      name: "x.example.com",
      env: "dev",
      web: { exposure: "staff", exceptions: [{ path: "/a" }] },
      allow: { tunnel: [{ route: "r.example.com", port: "22/sctp", who: [] }] },
    });
    expect(issues.map((i) => i.path).sort()).toEqual(
      ["allow.tunnel[0].port", "allow.tunnel[0].who", "env", "web.exceptions[0]"].sort(),
    );
  });

  it("accepts the documented forms of exception allow", () => {
    const d = (allow: unknown) => ({ name: "x.example.com", web: { exposure: "public", exceptions: [{ path: "/a", allow }] } });
    expect(validate("droplet", d("everyone"))).toEqual([]);
    expect(validate("droplet", d({ ips: ["192.0.2.1"] }))).toEqual([]);
    expect(validate("droplet", d({ service_tokens: ["uptime"] }))).toEqual([]);
    expect(validate("droplet", d({ ips: ["192.0.2.0/24"], service_tokens: ["uptime"] }))).toEqual([]);
    expect(validate("droplet", d({ ips: [] }))).toHaveLength(1);
  });
});
