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
      ["allow", "description", "env", "frozen", "monitors", "name", "profile", "ssh", "swarm", "web"].sort(),
    );
    expect(Object.keys(s.definitions.web!.properties!).sort()).toEqual(["access", "health_accept_app_404", "health_path", "hostnames", "origin"].sort());
    expect(Object.keys(s.definitions.allow!.properties!).sort()).toEqual(["droplet", "ip", "tunnel"]);
    expect(Object.keys(s.definitions.swarm!.properties!).sort()).toEqual(["cluster", "encrypted_overlay", "role"]);
    expect(Object.keys(s.definitions.monitor!.properties!).sort()).toEqual(["accept_app_404", "hostname", "path", "type"]);
  });

  it("account keys match the TypeScript model", () => {
    const s = readSchema("account") as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(s.properties).sort()).toEqual(["cloudflare", "digitalocean", "email_domain", "github", "groups", "oneuptime", "ssh_config", "telegram"]);
    expect(Object.keys(s.properties.cloudflare!.properties!).sort()).toEqual(
      ["account_id", "guards", "service_tokens", "staff_policy_id", "team_domain", "tunnels", "zones"].sort(),
    );
  });

  it("rejects unknown keys at every level", () => {
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], tags: ["web-staff"] })).toEqual([
      { segments: ["tags"], path: "tags", message: 'unknown key "tags"' },
    ]);
    expect(validate("profile", { name: "p", size: "s", image: "i", user_data: "u", region: "nyc1" })).toEqual([
      { segments: ["region"], path: "region", message: 'unknown key "region"' },
    ]);
  });

  it("rejects the removed keys deploy, web.exposure and cloudflare.ci_deploy_tokens", () => {
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], deploy: true }).map((i) => i.path)).toEqual(["deploy"]);
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], web: { exposure: "staff", access: { "/": ["staff"] } } }).map((i) => i.path)).toEqual([
      "web.exposure",
    ]);
    expect(validate("account", { cloudflare: { ci_deploy_tokens: {} } }).map((i) => i.path)).toContain("cloudflare.ci_deploy_tokens");
  });

  it("reports every problem at once, with dotted paths (a key that isn't a plain name is quoted)", () => {
    const issues = validate("droplet", {
      name: "x.example.com",
      ssh: ["admins"],
      env: "dev",
      web: { access: { "/": ["staff"], "/a": [] } },
      allow: { tunnel: [{ route: "r.example.com", port: "22/sctp", who: [] }] },
    });
    expect(issues.map((i) => i.path).sort()).toEqual(['web.access["/a"]', "allow.tunnel[0].port", "allow.tunnel[0].who", "env"].sort());
    expect(issues.find((i) => i.path === 'web.access["/a"]')!.message).toBe("a who-list needs at least one entry, each listed once");
  });

  it("accepts the documented who-list entries", () => {
    const d = (who: unknown[]) => ({ name: "x.example.com", ssh: ["admins"], web: { access: { "/": ["staff"], "/a": who } } });
    for (const who of [
      ["staff"],
      ["everyone"],
      ["admins", "shop-team"],
      ["someone@example.com"],
      ["token:uptime"],
      ["ip:192.0.2.1", "ip:198.51.100.0/24", "ip:2001:db8::/32"],
    ]) {
      expect(validate("droplet", d(who)), JSON.stringify(who)).toEqual([]);
    }
    for (const who of [[], ["Admins"], ["token:"], ["ip:example.com"], ["staff", "staff"]]) {
      expect(validate("droplet", d(who)), JSON.stringify(who)).toHaveLength(1);
    }
    // ssh takes the same entries (everyone and ip: are refused later, by src/checks).
    expect(validate("droplet", { name: "x.example.com", ssh: ["staff", "token:ci-prod", "admins", "someone@example.com"] })).toEqual([]);
  });

  it('requires web.access, and keys that are "/" or a path', () => {
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], web: {} })).toEqual([
      { segments: ["web"], path: "web", message: 'missing required key "access"' },
    ]);
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], web: { access: {} } }).map((i) => i.path)).toEqual(["web.access"]);
    expect(validate("droplet", { name: "x.example.com", ssh: ["admins"], web: { access: { "/": ["staff"], admin: ["staff"] } } })).toEqual([
      { segments: ["web", "access"], path: "web.access", message: 'a web.access key must be "/" or a path such as /admin' },
    ]);
  });

  it("rejects a group named staff or everyone", () => {
    for (const name of ["staff", "everyone"]) {
      const issues = validate("account", { groups: { [name]: ["a@example.com"] } }).filter((i) => i.path === "groups");
      expect(issues.map((i) => i.message), name).toContain("a group name is lowercase letters, digits and dashes, starting with a letter, and not staff or everyone");
    }
    expect(validate("account", { groups: { admins: ["a@example.com"] } }).filter((i) => i.path.startsWith("groups"))).toEqual([]);
  });
});
