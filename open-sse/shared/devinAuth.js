// Devin session helpers — fixed upstream hosts only. Session tokens, request
// bytes and signatures must never appear in logs or error messages.

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import {
  DEVIN_API_BASE,
  DEVIN_SERVER_BASE,
  DEVIN_SELF_PATH,
  DEVIN_SESSION_TOKEN_PREFIX,
  DEVIN_USER_STATUS_PATH,
} from "../config/devin.js";
import { buildGetUserStatusRequest, parseGetUserStatusResponse } from "../utils/devinProtobuf.js";

// Ensure the token carries the mandatory devin-session-token$ prefix.
export function formatSessionToken(rawToken) {
  const t = String(rawToken || "").trim();
  if (t.startsWith(DEVIN_SESSION_TOKEN_PREFIX)) return t;
  if (t.startsWith("eyJ")) return DEVIN_SESSION_TOKEN_PREFIX + t;
  return t;
}

// POST GetUserStatus (unary Connect-RPC, application/proto) against the fixed
// Devin server host. Returns {status, ok, data} — data is the parsed protobuf
// user status when the upstream returned a decodable 2xx body.
export async function fetchDevinUserStatus(token, proxyOptions = null) {
  const sessionToken = formatSessionToken(token);
  const body = buildGetUserStatusRequest(sessionToken);
  const res = await proxyAwareFetch(`${DEVIN_SERVER_BASE}${DEVIN_USER_STATUS_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${sessionToken}-${sessionToken}`,
      "Connect-Protocol-Version": "1",
      "Content-Type": "application/proto",
      Accept: "*/*",
    },
    body,
  }, proxyOptions || {});

  let data = null;
  if (res.ok) {
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      data = parseGetUserStatusResponse(buf);
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, data };
}

// GET api.devin.ai/v3/self — best-effort profile lookup. Never throws on
// non-2xx; returns null fields instead (matching the Go reference).
export async function fetchDevinSelfProfile(token, proxyOptions = null) {
  const sessionToken = formatSessionToken(token);
  const res = await proxyAwareFetch(`${DEVIN_API_BASE}${DEVIN_SELF_PATH}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      Accept: "application/json",
    },
  }, proxyOptions || {});

  if (res.status !== 200) return { userName: "", userId: "", orgId: "" };
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {
    userName: String(json?.user_name || ""),
    userId: String(json?.user_id || ""),
    orgId: String(json?.org_id || ""),
  };
}
