// Devin OAuth module — auth URL ordering, manual paste parsing, token
// exchange (no upstream body echoed on error), token mapping.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(async () => { throw new Error("should not hit upstream in these tests"); }) }));

const devin = (await import("../../src/lib/oauth/providers/devin.js")).default;
const { parseDevinAuthInput } = await import("../../src/lib/oauth/providers/devin.js");

describe("buildAuthUrl", () => {
  const cfg = devin.config;

  it("matches the Devin CLI query order for browser flow", () => {
    const url = devin.buildAuthUrl(cfg, "http://127.0.0.1:20128/callback", "st8", "ch4ll");
    expect(url).toBe(
      `${cfg.authorizeUrl}?redirect_uri=${encodeURIComponent("http://127.0.0.1:20128/callback")}` +
      `&state=st8&prompt=select_account&code_challenge=ch4ll&code_challenge_method=S256`,
    );
    expect(url).not.toContain("cli_pkce_marker");
  });

  it("headless flow omits redirect_uri and adds cli_pkce_marker=1", () => {
    const url = devin.buildAuthUrl(cfg, "http://127.0.0.1:20128/callback", "st8", "ch4ll", { headless: "1" });
    expect(url).toBe(
      `${cfg.authorizeUrl}?state=st8&prompt=select_account` +
      `&code_challenge=ch4ll&code_challenge_method=S256&cli_pkce_marker=1`,
    );
    expect(url).not.toContain("redirect_uri");
  });
});

describe("parseDevinAuthInput", () => {
  it("accepts raw codes, session tokens, JWTs, callback URLs", () => {
    expect(parseDevinAuthInput("abc123")).toEqual({ kind: "code", code: "abc123" });
    expect(parseDevinAuthInput('"abc123"')).toEqual({ kind: "code", code: "abc123" });
    expect(parseDevinAuthInput("devin-session-token$xyz")).toEqual({ kind: "token", token: "devin-session-token$xyz" });
    expect(parseDevinAuthInput("eyJhbGciOiJ.foo.bar")).toEqual({ kind: "token", token: "eyJhbGciOiJ.foo.bar" });
    expect(parseDevinAuthInput("http://127.0.0.1:20128/callback?code=c9&state=s"))
      .toEqual({ kind: "code", code: "c9" });
    expect(() => parseDevinAuthInput("https://app.devin.ai/cb?error=access_denied")).toThrow("Devin authorization denied");
  });

  it("rejects URL-shaped input carrying no code instead of using the URL as code", () => {
    expect(() => parseDevinAuthInput("https://app.devin.ai/callback?state=s")).toThrow("Devin callback URL has no authorization code");
    expect(() => parseDevinAuthInput("http://127.0.0.1:20128/callback")).toThrow("Devin callback URL has no authorization code");
    // URL-shaped but unparseable
    expect(() => parseDevinAuthInput("http://[::1")).toThrow("Devin callback URL has no authorization code");
  });
});

describe("exchangeToken", () => {
  beforeEach(() => fetchMock.mockReset());

  it("returns the token immediately for session-token paste (no fetch)", async () => {
    const out = await devin.exchangeToken(devin.config, "devin-session-token$raw", null, "ver");
    expect(out).toEqual({ token: "devin-session-token$raw" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts code + code_verifier and returns {token}", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ token: "tok-1" }) });
    const out = await devin.exchangeToken(devin.config, "code-1", null, "ver-1");
    expect(out).toEqual({ token: "tok-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(devin.config.tokenUrl);
    expect(JSON.parse(init.body)).toEqual({ code: "code-1", code_verifier: "ver-1" });
  });

  it("does not echo the upstream body on exchange failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "leaked-code-1" });
    await expect(devin.exchangeToken(devin.config, "code-1", null, "v"))
      .rejects.toThrow("Devin token exchange failed (HTTP 403)");
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(devin.exchangeToken(devin.config, "code-1", null, "v"))
      .rejects.toThrow(/HTTP 500/);
  });

  it("throws when the response carries no token", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(devin.exchangeToken(devin.config, "code-1", null, "v"))
      .rejects.toThrow("no token");
  });

  it("callback URL without a code rejects and never hits the network", async () => {
    await expect(devin.exchangeToken(devin.config, "https://app.devin.ai/callback?state=s", null, "v"))
      .rejects.toThrow("Devin callback URL has no authorization code");
    await expect(devin.exchangeToken(devin.config, "http://[::1", null, "v"))
      .rejects.toThrow("Devin callback URL has no authorization code");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mapTokens", () => {
  it("maps a permanent session token: no refresh token, no expiry", () => {
    const mapped = devin.mapTokens({ token: "eyJfoo.bar" }, {
      email: "u@x.io", userName: "Dev User", userId: "u1", orgId: "o1", orgName: "Acme", plan: "core",
    });
    expect(mapped.accessToken).toBe("devin-session-token$eyJfoo.bar");
    expect(mapped.refreshToken).toBeUndefined();
    expect(mapped.expiresIn).toBeUndefined();
    expect(mapped.email).toBe("u@x.io");
    expect(mapped.displayName).toBe("Dev User");
    expect(mapped.providerSpecificData).toEqual({ userId: "u1", orgId: "o1", orgName: "Acme", plan: "core" });
  });

  it("keeps an already-prefixed token unchanged", () => {
    expect(devin.mapTokens({ token: "devin-session-token$t" }, {}).accessToken).toBe("devin-session-token$t");
  });
});

describe("provider registration shape", () => {
  it("uses PKCE with a 64-byte verifier", () => {
    expect(devin.flowType).toBe("authorization_code_pkce");
    expect(devin.pkceVerifierBytes).toBe(64);
  });
});
