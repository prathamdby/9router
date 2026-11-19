/**
 * Devin usage — Connect-RPC GetUserStatus against server.codeium.com.
 * Quotas come back as remaining-percent figures with unix reset timestamps;
 * rows are emitted in the same shape the dashboard consumes elsewhere.
 */

import { fetchDevinUserStatus } from "../../shared/devinAuth.js";

function formatDevinPlanLabel(rawPlan) {
  const raw = String(rawPlan || "").trim();
  if (!raw) return "Devin";
  return raw
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// The dashboard's generic normalizer keeps only used/total/percentage/resetAt
// and treats total 0 as unlimited, so remaining-percent quotas are expressed as
// used out of 100.
function makePercentQuotaRow(remainingPercent, resetAt) {
  const pct = Math.round(Math.max(0, Math.min(100, Number(remainingPercent) || 0)));
  return {
    used: 100 - pct,
    total: 100,
    resetAt: resetAt || null,
  };
}

export function parseDevinUserStatusUsage(data) {
  if (!data || typeof data !== "object") {
    return { plan: "Devin", quotas: {}, message: "Devin quota data unavailable." };
  }
  const quotas = {};
  quotas["Daily"] = makePercentQuotaRow(data.dailyQuotaRemainingPercent, data.dailyQuotaResetAt);
  quotas["Weekly"] = makePercentQuotaRow(data.weeklyQuotaRemainingPercent, data.weeklyQuotaResetAt);
  return {
    plan: formatDevinPlanLabel(data.plan),
    quotas,
    message: null,
    planId: data.plan || null,
    orgName: data.orgName || null,
  };
}

/**
 * @param {string|null|undefined} accessToken Devin session token
 * @param {object|null|undefined} proxyOptions
 */
export async function getDevinUsage(accessToken = null, proxyOptions = null) {
  if (!accessToken || typeof accessToken !== "string" || !accessToken.trim()) {
    return { message: "Devin session token not available. Re-connect Devin to view quota." };
  }
  try {
    const res = await fetchDevinUserStatus(accessToken.trim(), proxyOptions);
    if (res.status === 401 || res.status === 403) {
      return { message: "Devin authentication failed. Re-connect Devin from the dashboard." };
    }
    if (!res.ok || !res.data) {
      return { message: `Devin quota unavailable (HTTP ${res.status}).` };
    }
    return parseDevinUserStatusUsage(res.data);
  } catch (error) {
    return { message: `Devin error: ${error.message || "Failed to fetch quota"}` };
  }
}
