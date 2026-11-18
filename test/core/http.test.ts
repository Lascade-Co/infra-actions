import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, WriteNotAllowedError } from "../../src/core/http.js";
import { MissingSecretError, Secrets } from "../../src/core/secrets.js";

const TOKEN = "fake-token-value-1234";

function client(allowWrites: boolean, respond: (url: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => respond(url, init));
  const c = new ApiClient({ baseUrl: "https://api.example.com/v1", headers: { Authorization: `Bearer ${TOKEN}` }, fetch, allowWrites, name: "test" });
  return { c, fetch };
}

describe("ApiClient", () => {
  it("refuses writes before any request when the run is read-only", async () => {
    const { c, fetch } = client(false, () => new Response("{}"));
    await expect(c.request("POST", "/things", { body: { a: 1 } })).rejects.toBeInstanceOf(WriteNotAllowedError);
    await expect(c.request("delete", "/things/1")).rejects.toBeInstanceOf(WriteNotAllowedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a non-GET call marked as a read (POST query endpoints) in a read-only run", async () => {
    const { c, fetch } = client(false, () => new Response(JSON.stringify({ data: [] })));
    expect(await c.request("POST", "/monitor/get-list", { body: { query: {} }, read: true })).toEqual({ data: [] });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "POST" });
  });

  it("reads with query parameters and the auth header", async () => {
    const { c, fetch } = client(false, () => new Response(JSON.stringify({ result: [1] })));
    expect(await c.get("/things", { page: 2, per_page: 50, skip: undefined })).toEqual({ result: [1] });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/things?page=2&per_page=50");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("writes when allowed", async () => {
    const { c, fetch } = client(true, () => new Response(JSON.stringify({ ok: true })));
    await c.request("PUT", "/things/1", { body: { a: 1 } });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: '{"a":1}' });
  });

  it("turns API errors into ApiError without the token", async () => {
    const { c } = client(false, () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 }));
    const err = await c.get("/things").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("test GET /things: HTTP 403 (10000 Authentication error)");
    expect((err as ApiError).message).not.toContain(TOKEN);
  });

  it("fails on success:false even with HTTP 200, and on non-JSON", async () => {
    let { c } = client(false, () => new Response(JSON.stringify({ success: false, errors: [] })));
    await expect(c.get("/x")).rejects.toBeInstanceOf(ApiError);
    ({ c } = client(false, () => new Response("<html>", { status: 502 })));
    await expect(c.get("/x")).rejects.toThrow("non-JSON");
  });
});

describe("Secrets", () => {
  const s = new Secrets({ CF_API_TOKEN: TOKEN, DO_TOKEN: "  ", PATH: "/usr/bin" });

  it("reads only the known variables, ignoring blanks", () => {
    expect(s.has("CF_API_TOKEN")).toBe(true);
    expect(s.has("DO_TOKEN")).toBe(false);
    expect(s.require("CF_API_TOKEN")).toBe(TOKEN);
  });

  it("names the variable, never a value, when one is missing", () => {
    expect(() => s.require("DO_TOKEN")).toThrow(MissingSecretError);
    expect(() => s.require("DO_TOKEN")).toThrow("environment variable DO_TOKEN is not set");
  });

  it("redacts values and never serialises them", () => {
    expect(s.redact(`token=${TOKEN}; again ${TOKEN}`)).toBe("token=***; again ***");
    expect(JSON.stringify({ s })).not.toContain(TOKEN);
    expect(JSON.parse(JSON.stringify(s))).toMatchObject({ CF_API_TOKEN: true, DO_TOKEN: false });
  });
});
