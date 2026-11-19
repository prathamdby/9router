// loopbackTwin — localhost <-> 127.0.0.1, same scheme+port, nothing else.
import { describe, it, expect } from "vitest";
import { loopbackTwin } from "../../src/shared/utils/loopbackOrigin.js";

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
