import { describe, expect, it } from "vitest";
import { flattenName, isOneLevel } from "../../src/core/naming.js";
import { formatPort, formatWho, normPath, parseCidr, parsePort, parseWho, ValueError } from "../../src/core/values.js";

const ZONES = ["example.com", "example.net", "sub.example.net"];

describe("flattenName (ported from infra-sync)", () => {
  it("flattens multi-level names and builds ssh-/vpc- names", () => {
    expect(flattenName("staging.app.example.com", ZONES)).toEqual({
      ok: true,
      zone: "example.com",
      label: "staging-app",
      sshHostname: "ssh-staging-app.example.com",
      vpcHostname: "vpc-staging-app.example.com",
    });
  });
  it("uses the longest zone suffix on a dot boundary", () => {
    expect(flattenName("a.sub.example.net", ZONES)).toMatchObject({ ok: true, zone: "sub.example.net", label: "a" });
    expect(flattenName("app.notexample.com", ZONES)).toMatchObject({ ok: false });
  });
  it("reports names it can't manage, never guesses", () => {
    expect(flattenName("Build-Box", ZONES)).toMatchObject({ ok: false, reason: expect.stringContaining("uppercase") });
    expect(flattenName("build-box", ZONES)).toMatchObject({ ok: false, reason: expect.stringContaining("not a domain in any account zone") });
    expect(flattenName("example.com", ZONES)).toMatchObject({ ok: false, reason: expect.stringContaining("apex") });
    expect(flattenName("x.example.com.new", ZONES)).toMatchObject({ ok: false });
    expect(flattenName(`${"a".repeat(60)}.example.com`, ZONES)).toMatchObject({ ok: false, reason: expect.stringContaining("63") });
  });
  it("knows one-level names", () => {
    expect(isOneLevel("shop.example.com", ZONES)).toBe(true);
    expect(isOneLevel("staging.shop.example.com", ZONES)).toBe(false);
  });
});

describe("parsePort", () => {
  it("parses single ports and ranges with protocol", () => {
    expect(parsePort("8443/tcp")).toEqual({ from: 8443, to: 8443, protocol: "tcp", raw: "8443/tcp" });
    expect(parsePort("9000-9001/udp")).toMatchObject({ from: 9000, to: 9001, protocol: "udp" });
    expect(formatPort(parsePort("9000-9001/udp"))).toBe("9000-9001/udp");
  });
  it.each(["8443", "8443/TCP", "0/tcp", "70000/tcp", "9001-9000/tcp", "22/icmp", "a/tcp"])("rejects %s", (p) => {
    expect(() => parsePort(p)).toThrow(ValueError);
  });
});

describe("parseCidr", () => {
  it("normalises bare addresses and keeps prefixes", () => {
    expect(parseCidr("203.0.113.9")).toBe("203.0.113.9/32");
    expect(parseCidr("198.51.100.0/24")).toBe("198.51.100.0/24");
    expect(parseCidr("2001:DB8::1")).toBe("2001:db8::1/128");
  });
  it.each(["300.1.1.1", "192.0.2.1/33", "192.0.2.1/24/1", "example.com", ""])("rejects %s", (v) => {
    expect(() => parseCidr(v)).toThrow(ValueError);
  });
});

describe("parseWho", () => {
  it("parses staff and service tokens", () => {
    expect(parseWho("staff")).toEqual({ kind: "staff" });
    expect(parseWho("service-token:etl")).toEqual({ kind: "service-token", name: "etl" });
    expect(formatWho({ kind: "service-token", name: "etl" })).toBe("service-token:etl");
  });
  it.each(["everyone", "service-token:", "service-token:ETL", "email:a@example.com"])("rejects %s", (v) => {
    expect(() => parseWho(v)).toThrow(ValueError);
  });
});

describe("normPath", () => {
  it("lowercases and drops trailing slashes", () => {
    expect(normPath("/Admin/")).toBe("/admin");
    expect(normPath("/")).toBe("");
  });
});
