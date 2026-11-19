// loopbackTwin — localhost <-> 127.0.0.1, same scheme+port, nothing else.
import { describe, it, expect } from "vitest";
import { loopbackTwin, isTrustedOAuthMessageOrigin } from "../../src/shared/utils/loopbackOrigin.js";

describe("loopbackTwin", () => {
  it("swaps localhost <-> 127.0.0.1 preserving scheme and port", () => {
    expect(loopbackTwin("http://localhost:20128")).toBe("http://127.0.0.1:20128");
    expect(loopbackTwin("http://127.0.0.1:20128")).toBe("http://localhost:20128");
    expect(loopbackTwin("https://localhost")).toBe("https://127.0.0.1");
    expect(loopbackTwin("https://127.0.0.1:8443")).toBe("https://localhost:8443");
  });

  it("rejects non-loopback hosts and non-http schemes", () => {
    expect(loopbackTwin("http://example.com:20128")).toBeNull();
    expect(loopbackTwin("http://localhost.evil.com")).toBeNull();
    expect(loopbackTwin("http://[::1]:3000")).toBeNull();
    expect(loopbackTwin("ftp://localhost:21")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(loopbackTwin("not a url")).toBeNull();
    expect(loopbackTwin("")).toBeNull();
    expect(loopbackTwin(null)).toBeNull();
    expect(loopbackTwin(undefined)).toBeNull();
  });
});

describe("isTrustedOAuthMessageOrigin", () => {
  const SELF = "http://localhost:20128";

  it("accepts same origin and loopback origins on any port", () => {
    expect(isTrustedOAuthMessageOrigin(SELF, SELF)).toBe(true);
    expect(isTrustedOAuthMessageOrigin("http://localhost:1455", SELF)).toBe(true);
    expect(isTrustedOAuthMessageOrigin("http://127.0.0.1:56121", SELF)).toBe(true);
    expect(isTrustedOAuthMessageOrigin("http://127.0.0.1:20127", SELF)).toBe(true);
    expect(isTrustedOAuthMessageOrigin("https://localhost:8443", SELF)).toBe(true);
  });

  it("rejects look-alike hostnames and foreign origins", () => {
    expect(isTrustedOAuthMessageOrigin("https://localhost.evil.com", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("http://127.0.0.1.evil.com", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("http://evil.com", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("http://localhost.attacker.io:1455", SELF)).toBe(false);
  });

  it("rejects null-ish, empty and unparseable origins", () => {
    expect(isTrustedOAuthMessageOrigin("null", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("garbage", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin("file:///etc/passwd", SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin(null, SELF)).toBe(false);
    expect(isTrustedOAuthMessageOrigin(undefined, SELF)).toBe(false);
  });
});
