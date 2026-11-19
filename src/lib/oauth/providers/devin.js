// Devin OAuth — PKCE login at app.devin.ai/auth/cli/continue, token exchange at
// api.devin.ai/auth/cli/token. Supports the headless manual flow (no redirect,
// cli_pkce_marker=1) and direct session-token paste. Upstream response bodies
// are never echoed in errors — they can echo back the submitted code/token.

import {
  DEVIN_APP_BASE,
  DEVIN_API_BASE,
  DEVIN_AUTHORIZE_PATH,
  DEVIN_TOKEN_PATH,
  DEVIN_SESSION_TOKEN_PREFIX,
} from "open-sse/config/devin.js";
import { formatSessionToken, fetchDevinSelfProfile, fetchDevinUserStatus } from "open-sse/shared/devinAuth.js";

const DEVIN_CONFIG = {
  authorizeUrl: DEVIN_APP_BASE + DEVIN_AUTHORIZE_PATH,
  tokenUrl: DEVIN_API_BASE + DEVIN_TOKEN_PATH,
};

// Manual paste accepts: raw auth code, devin-session-token$…, JWT (eyJ…),
// or a callback URL carrying ?code= (and optionally ?state= / ?error=).
function parseDevinAuthInput(raw) {
  const input = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (/^https?:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new Error("Devin callback URL has no authorization code");
    }
    const errParam = url.searchParams.get("error");
    if (errParam) throw new Error("Devin authorization denied");
    const code = url.searchParams.get("code");
    if (code) return { kind: "code", code };
    throw new Error("Devin callback URL has no authorization code");
  }
  if (input.startsWith(DEVIN_SESSION_TOKEN_PREFIX) || input.startsWith("eyJ")) {
    return { kind: "token", token: input };
  }
  return { kind: "code", code: input };
}

const devin = {
  config: DEVIN_CONFIG,
  flowType: "authorization_code_pkce",
  pkceVerifierBytes: 64,

  // Query order mirrors the official Devin CLI exactly:
  //   redirect_uri? → state? → prompt → code_challenge → method → cli_pkce_marker?
  buildAuthUrl: (config, redirectUri, state, codeChallenge, meta = {}) => {
    const headless = meta.headless === true || meta.headless === "1" || meta.headless === "true";
    const parts = [];
    if (!headless && redirectUri) parts.push(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    if (state) parts.push(`state=${encodeURIComponent(state)}`);
    parts.push("prompt=select_account");
    parts.push(`code_challenge=${encodeURIComponent(codeChallenge)}`);
    parts.push("code_challenge_method=S256");
    if (headless) parts.push("cli_pkce_marker=1");
    return `${config.authorizeUrl}?${parts.join("&")}`;
  },

  exchangeToken: async (config, code, redirectUri, codeVerifier) => {
    const parsed = parseDevinAuthInput(code);
    if (parsed.kind === "token") {
      return { token: parsed.token };
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        code: String(parsed.code).trim(),
        code_verifier: String(codeVerifier || "").trim(),
      }),
    });

    if (!response.ok) {
      // Deliberately no response body: upstream errors can echo submitted codes.
      throw new Error(`Devin token exchange failed (HTTP ${response.status})`);
    }

    const data = await response.json().catch(() => null);
    const token = data?.token ? String(data.token).trim() : "";
    if (!token) {
      throw new Error("Devin token exchange returned no token");
    }
    return { token };
  },

  // Best-effort enrichment: profile (v3/self) + quota/plan (GetUserStatus).
  postExchange: async (tokens) => {
    const token = formatSessionToken(tokens?.token || "");
    const extra = {};
    try {
      const profile = await fetchDevinSelfProfile(token);
      Object.assign(extra, { userName: profile.userName, userId: profile.userId, orgId: profile.orgId });
    } catch { /* best-effort */ }
    try {
      const status = await fetchDevinUserStatus(token);
      if (status.ok && status.data) {
        extra.email = status.data.email || extra.email;
        extra.userName = extra.userName || status.data.userName;
        extra.userId = extra.userId || status.data.userId;
        extra.orgId = extra.orgId || status.data.orgId;
        extra.orgName = status.data.orgName || "";
        extra.plan = status.data.plan || "";
      }
    } catch { /* best-effort */ }
    return extra;
  },

  // Permanent session token: no refresh token, no expiry.
  mapTokens: (tokens, extra = {}) => {
    const accessToken = formatSessionToken(tokens?.token || "");
    const mapped = {
      accessToken,
      providerSpecificData: {
        userId: extra.userId || "",
        orgId: extra.orgId || "",
        orgName: extra.orgName || "",
        plan: extra.plan || "",
      },
    };
    if (extra.email) mapped.email = extra.email;
    const displayName = extra.userName || extra.email || "";
    if (displayName) mapped.displayName = displayName;
    return mapped;
  },
};

export default devin;
export { parseDevinAuthInput };
