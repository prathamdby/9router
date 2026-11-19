// Devin model uid resolution — ported from CLIProxyAPI
// internal/runtime/executor/helps/devin_models.go against the DEVIN_MODELS
// catalog in open-sse/config/devin.js.

import { DEVIN_MODELS, DEVIN_STANDARD_LEVEL_ORDER } from "../config/devin.js";

const KNOWN_DEVIN_SUFFIXES = [
  "-none",
  "-low",
  "-medium",
  "-high",
  "-xhigh",
  "-max",
  "-fast",
  "-slow",
  "-priority",
  "-low-priority",
  "-medium-priority",
  "-high-priority",
  "-xhigh-priority",
  "-max-priority",
  "-low-fast",
  "-medium-fast",
  "-high-fast",
  "-xhigh-fast",
  "-max-fast",
  "-none-fast",
  "-thinking-1m",
  "-thinking",
  "-max-1m",
  "-none-1m",
  "-minimal-lightning",
  "-low-lightning",
  "-medium-lightning",
  "-high-lightning",
  "-xhigh-lightning",
  "-max-lightning",
  "-none-lightning",
  "_none",
  "_minimal",
  "_low",
  "_medium",
  "_high",
  "_xhigh",
  "_max",
  "_thinking",
];

const SPECIAL_DEVIN_ALIASES = {
  "claude-haiku-4-5": "MODEL_PRIVATE_11",
  "gpt-4-1": "MODEL_CHAT_GPT_4_1_2025_04_14",
};

export function hasDevinEffortSuffix(model) {
  const lower = String(model || "").trim().toLowerCase();
  return KNOWN_DEVIN_SUFFIXES.some((s) => lower.endsWith(s));
}

// Numeric budgets or loose effort strings → canonical Devin efforts.
export function normalizeThinkingLevel(level, budgetTokens = 0) {
  const normalized = String(level || "").trim().toLowerCase();
  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    case "fast":
      return normalized;
    case "none":
    case "off":
    case "disabled":
      return "none";
    case "auto":
    case "adaptive":
      return "high";
  }
  const budget = Number(budgetTokens) || 0;
  if (budget > 0) {
    if (budget <= 4096) return "low";
    if (budget <= 16384) return "medium";
    if (budget <= 32768) return "high";
    return "max";
  }
  return "";
}

function lookupDevinModel(base) {
  return DEVIN_MODELS.find((m) => m.id === base) || null;
}

function devinLevelIndex(level) {
  return DEVIN_STANDARD_LEVEL_ORDER.indexOf(String(level || "").trim().toLowerCase());
}

function clampEffort(requested, allowed, defaultEffort) {
  if (!requested) return defaultEffort;
  const reqLower = String(requested).trim().toLowerCase();
  for (const a of allowed) {
    if (reqLower === String(a).trim().toLowerCase()) return a;
  }
  if (reqLower === "none") return defaultEffort;
  const reqIdx = devinLevelIndex(reqLower);
  if (reqIdx === -1) return defaultEffort;

  let bestMatch = defaultEffort;
  let bestDist = 999;
  let bestIdx = -1;
  for (const a of allowed) {
    const aIdx = devinLevelIndex(a);
    if (aIdx === -1) continue;
    const dist = Math.abs(reqIdx - aIdx);
    if (dist < bestDist || (dist === bestDist && aIdx > bestIdx)) {
      bestDist = dist;
      bestMatch = a;
      bestIdx = aIdx;
    }
  }
  return bestMatch;
}

function selectDefaultDevinEffort(baseModel, levels) {
  if (baseModel.includes("swe-2")) return "high";
  const has = (l) => levels.includes(l);
  if (has("none") && has("low") && baseModel.startsWith("gpt-5")) return "low";
  if (has("high") && /gemini|grok|glm|deepseek|kimi|nemotron/.test(baseModel)) return "high";
  if (has("medium")) return "medium";
  if (has("high")) return "high";
  if (has("low")) return "low";
  return levels[0];
}

// Parse a trailing "(suffix)" — mirrors thinking.ParseSuffix in the reference.
function parseParenSuffix(model) {
  const lastOpen = model.lastIndexOf("(");
  if (lastOpen === -1 || !model.endsWith(")")) return { modelName: model, hasSuffix: false, rawSuffix: "" };
  return { modelName: model.slice(0, lastOpen), rawSuffix: model.slice(lastOpen + 1, -1), hasSuffix: true };
}

// Resolve a model identifier into a valid upstream Devin chat_model_uid.
export function resolveDevinModelUid(rawModel, thinkingLevel = "", budgetTokens = 0) {
  const model = String(rawModel || "").trim();
  if (!model) return "swe-2-high";

  let cleanModel = model;
  if (cleanModel.toLowerCase().startsWith("devin/")) cleanModel = cleanModel.slice(6);

  if (hasDevinEffortSuffix(cleanModel)) return cleanModel;

  let baseModel = cleanModel;
  let level = thinkingLevel;
  const parsed = parseParenSuffix(cleanModel);
  if (parsed.hasSuffix) {
    baseModel = parsed.modelName.trim();
    level = parsed.rawSuffix;
  } else {
    const colonIdx = cleanModel.lastIndexOf(":");
    if (colonIdx !== -1) {
      baseModel = cleanModel.slice(0, colonIdx).trim();
      level = cleanModel.slice(colonIdx + 1).trim();
    }
  }

  const rawLevel = String(level || "").trim().toLowerCase();
  const effort = normalizeThinkingLevel(level, budgetTokens);
  const lowerBase = baseModel.toLowerCase();
  let canonicalBase = lowerBase.replaceAll(".", "-");

  if (SPECIAL_DEVIN_ALIASES[canonicalBase]) return SPECIAL_DEVIN_ALIASES[canonicalBase];
  if (canonicalBase === "claude-sonnet-4-5" || canonicalBase.includes("sonnet-4-5")) {
    return effort && effort !== "none" ? "MODEL_PRIVATE_3" : "MODEL_PRIVATE_2";
  }
  if (canonicalBase === "gemini-3-flash") canonicalBase = "gemini-3-8-flash";

  const normalizedUnder = canonicalBase.replaceAll("-", "_");
  if (normalizedUnder === "model_gpt_5_2") {
    return "MODEL_GPT_5_2_" + clampEffort(effort, ["none", "low", "medium", "high", "xhigh"], "low").toUpperCase();
  }
  if (normalizedUnder === "model_google_gemini_3_0_flash") {
    return "MODEL_GOOGLE_GEMINI_3_0_FLASH_" + clampEffort(effort, ["minimal", "low", "medium", "high"], "high").toUpperCase();
  }
  if (normalizedUnder === "model_claude_4_5_opus") {
    return effort && effort !== "none" ? "MODEL_CLAUDE_4_5_OPUS_THINKING" : "MODEL_CLAUDE_4_5_OPUS";
  }

  let modelInfo = lookupDevinModel(canonicalBase);
  if (!modelInfo && canonicalBase !== lowerBase) modelInfo = lookupDevinModel(lowerBase);
  const allowedLevels = modelInfo && Array.isArray(modelInfo.levels) && modelInfo.levels.length ? modelInfo.levels : [];

  switch (canonicalBase) {
    case "swe-1-7":
      return effort === "medium" ? "swe-1-7-medium" : "swe-1-7";
    case "swe-1-6":
      return effort === "fast" ? "swe-1-6-fast" : "swe-1-6";
    case "glm-5-2":
      if (effort === "none") return "glm-5-2-none";
      if (effort === "max") return "glm-5-2-max";
      return "glm-5-2";
    case "glm-5-2-1m":
      if (effort === "none") return "glm-5-2-none-1m";
      if (effort === "max") return "glm-5-2-max-1m";
      return "glm-5-2-1m";
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return effort && effort !== "none" ? canonicalBase + "-thinking" : canonicalBase;
    case "claude-opus-4-6-1m":
      return effort && effort !== "none" ? "claude-opus-4-6-thinking-1m" : canonicalBase;
    case "claude-sonnet-4-6-1m":
      return effort && effort !== "none" ? "claude-sonnet-4-6-thinking-1m" : canonicalBase;
  }

  // Lightning tier keeps the effort before the suffix (swe-2-high-lightning).
  if (canonicalBase.endsWith("-lightning")) {
    const stem = canonicalBase.slice(0, -"-lightning".length);
    if (hasDevinEffortSuffix(stem)) return canonicalBase;
    if (!allowedLevels.length) return canonicalBase;
    const defaultEffort = selectDefaultDevinEffort(stem, allowedLevels);
    return `${stem}-${clampEffort(effort, allowedLevels, defaultEffort)}-lightning`;
  }

  if (!allowedLevels.length) return canonicalBase;

  // "<level>-fast" requests keep their level clamped to the catalog.
  if (rawLevel.endsWith("-fast")) {
    const base = rawLevel.slice(0, -"-fast".length);
    if (devinLevelIndex(base) !== -1) {
      const defaultEffort = selectDefaultDevinEffort(canonicalBase, allowedLevels);
      return `${canonicalBase}-${clampEffort(base, allowedLevels, defaultEffort)}-fast`;
    }
  }

  const defaultEffort = selectDefaultDevinEffort(canonicalBase, allowedLevels);
  const clamped = clampEffort(effort, allowedLevels, defaultEffort);
  if (effort === "fast") return `${canonicalBase}-${clamped}-fast`;
  return `${canonicalBase}-${clamped}`;
}
