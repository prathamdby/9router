// Devin quota/usage — GetUserStatus → dashboard rows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  encodeStringField,
  encodeVarintField,
  encodeBytesField,
  concatBytes,
} from "open-sse/utils/devinProtobuf.js";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

const { getDevinUsage, parseDevinUserStatusUsage } = await import("open-sse/services/usage/devin.js");
const { fetchDevinUserStatus } = await import("open-sse/shared/devinAuth.js");

function userStatusBody({ plan = "core", daily = 80, weekly = 55, dailyReset = 1700001000, weeklyReset = 1700002000 } = {}) {
  const org = concatBytes(encodeStringField(4, "org-1"), encodeStringField(8, "Acme"));
  const planInfo = concatBytes(encodeStringField(2, plan), encodeBytesField(33, org));
  const planStatus = concatBytes(
    encodeBytesField(1, planInfo),
    encodeVarintField(14, daily),
    encodeVarintField(15, weekly),
    encodeVarintField(17, dailyReset),
    encodeVarintField(18, weeklyReset),
  );
  const userStatus = concatBytes(
    encodeStringField(3, "devuser"),
    encodeStringField(7, "u@x.io"),
    encodeBytesField(13, planStatus),
    encodeStringField(36, "uid-1"),
  );
  return encodeBytesField(1, userStatus);
}

describe("getDevinUsage", () => {
  beforeEach(() => fetchMock.mockReset());

  it("maps user status to plan + Daily/Weekly remaining-percent rows", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => userStatusBody().buffer,
    });
    const res = await getDevinUsage("devin-session-token$t");
    expect(res.plan).toBe("Core");
    expect(res.quotas.Daily).toEqual({ used: 20, total: 100, resetAt: res.quotas.Daily.resetAt });
    expect(new Date(res.quotas.Daily.resetAt).getTime()).toBe(1700001000 * 1000);
    expect(res.quotas.Weekly).toEqual({ used: 45, total: 100, resetAt: res.quotas.Weekly.resetAt });
    expect(new Date(res.quotas.Weekly.resetAt).getTime()).toBe(1700002000 * 1000);
    expect(res.orgName).toBe("Acme");
  });

  it("clamps remaining percent to 0..100 before converting to used", () => {
    const res = parseDevinUserStatusUsage({
      plan: "core",
      dailyQuotaRemainingPercent: 140,
      weeklyQuotaRemainingPercent: -5,
      dailyQuotaResetAt: 1700001000,
      weeklyQuotaResetAt: 1700002000,
    });
    expect(res.quotas.Daily.used).toBe(0);
    expect(res.quotas.Daily.total).toBe(100);
    expect(res.quotas.Weekly.used).toBe(100);
    expect(res.quotas.Weekly.total).toBe(100);
  });

  it("missing token → guidance message, no fetch", async () => {
    const res = await getDevinUsage(null);
    expect(res.message).toContain("session token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401/403 → auth failure message without the token", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) });
    const res = await getDevinUsage("devin-session-token$secret");
    expect(res.message).toContain("authentication failed");
    expect(res.message).not.toContain("secret");
  });

  it("other HTTP failures → quota unavailable message", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0) });
    const res = await getDevinUsage("devin-session-token$t");
    expect(res.message).toContain("503");
  });

  it("network error → safe error message", async () => {
    fetchMock.mockRejectedValueOnce(new Error("conn refused"));
    const res = await getDevinUsage("devin-session-token$t");
    expect(res.message).toContain("conn refused");
  });
});

describe("fetchDevinUserStatus", () => {
  beforeEach(() => fetchMock.mockReset());

  it("posts unary protobuf with Basic <token>-<token> auth to the fixed host", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => userStatusBody().buffer,
    });
    const res = await fetchDevinUserStatus("eyJraw-jwt");
    expect(res.status).toBe(200);
    expect(res.data.plan).toBe("core");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/exa.seat_management_pb.SeatManagementService/GetUserStatus");
    expect(init.headers.Authorization).toBe("Basic devin-session-token$eyJraw-jwt-devin-session-token$eyJraw-jwt");
    expect(init.headers["Content-Type"]).toBe("application/proto");
    expect(init.body instanceof Uint8Array).toBe(true);
  });
});

describe("parseDevinUserStatusUsage", () => {
  it("handles empty data", () => {
    expect(parseDevinUserStatusUsage(null).message).toBeTruthy();
  });
});
