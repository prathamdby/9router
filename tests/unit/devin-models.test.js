// Devin model uid resolution — vectors ported from
// internal/runtime/executor/helps/devin_models.go.
import { describe, it, expect } from "vitest";
import { resolveDevinModelUid, hasDevinEffortSuffix, normalizeThinkingLevel } from "open-sse/utils/devinModels.js";
import { DEVIN_MODELS } from "open-sse/config/devin.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { applyThinking } from "open-sse/translator/concerns/thinkingUnified.js";

describe("resolveDevinModelUid", () => {
  it("defaults and prefix handling", () => {
    expect(resolveDevinModelUid("")).toBe("swe-2-high");
    expect(resolveDevinModelUid("  ")).toBe("swe-2-high");
    expect(resolveDevinModelUid("devin/swe-2")).toBe("swe-2-high");
    expect(resolveDevinModelUid("DEVIN/swe-2")).toBe("swe-2-high");
    expect(resolveDevinModelUid("swe-2")).toBe("swe-2-high");
  });

  it("preserves ids that already end in a known effort suffix", () => {
    expect(resolveDevinModelUid("swe-2-max")).toBe("swe-2-max");
    expect(resolveDevinModelUid("claude-opus-4-7-xhigh")).toBe("claude-opus-4-7-xhigh");
    expect(resolveDevinModelUid("gpt-5-5-none-fast")).toBe("gpt-5-5-none-fast");
    expect(resolveDevinModelUid("swe-2_high")).toBe("swe-2_high");
  });

  it("special private aliases", () => {
    expect(resolveDevinModelUid("claude-haiku-4-5")).toBe("MODEL_PRIVATE_11");
    expect(resolveDevinModelUid("claude-haiku-4.5")).toBe("MODEL_PRIVATE_11");
    expect(resolveDevinModelUid("gpt-4-1")).toBe("MODEL_CHAT_GPT_4_1_2025_04_14");
    expect(resolveDevinModelUid("claude-sonnet-4-5")).toBe("MODEL_PRIVATE_2");
    expect(resolveDevinModelUid("claude-sonnet-4-5:high")).toBe("MODEL_PRIVATE_3");
    expect(resolveDevinModelUid("model_claude_4_5_opus")).toBe("MODEL_CLAUDE_4_5_OPUS");
    expect(resolveDevinModelUid("model_claude_4_5_opus:high")).toBe("MODEL_CLAUDE_4_5_OPUS_THINKING");
    expect(resolveDevinModelUid("model_gpt_5_2")).toBe("MODEL_GPT_5_2_LOW");
    expect(resolveDevinModelUid("model_gpt_5_2:xhigh")).toBe("MODEL_GPT_5_2_XHIGH");
    expect(resolveDevinModelUid("model_google_gemini_3_0_flash")).toBe("MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH");
  });

  it("colon and parenthesis suffixes", () => {
    expect(resolveDevinModelUid("swe-2:max")).toBe("swe-2-max");
    expect(resolveDevinModelUid("swe-2(max)")).toBe("swe-2-max");
    expect(resolveDevinModelUid("claude-opus-4-7:low")).toBe("claude-opus-4-7-low");
  });

  it("resolves SWE-2.1 through dotted and canonical ids", () => {
    expect(resolveDevinModelUid("swe-2.1")).toBe("swe-2-1-high");
    expect(resolveDevinModelUid("swe-2-1")).toBe("swe-2-1-high");
    expect(resolveDevinModelUid("swe-2-1:medium")).toBe("swe-2-1-medium");
    expect(resolveDevinModelUid("swe-2-1:xhigh")).toBe("swe-2-1-xhigh");
    expect(resolveDevinModelUid("swe-2-1:max")).toBe("swe-2-1-max");
  });

  it("thinking level / budget parameters drive effort", () => {
    expect(resolveDevinModelUid("swe-2", "max")).toBe("swe-2-max");
    // 2000 budget → "low" → clamped up to medium (swe-2 lacks low/minimal)
    expect(resolveDevinModelUid("swe-2", "", 2000)).toBe("swe-2-medium");
    // 40000 budget → "max" → swe-2-max
    expect(resolveDevinModelUid("swe-2", "", 40000)).toBe("swe-2-max");
  });

  it("special base models stay bare unless a specific variant is requested", () => {
    expect(resolveDevinModelUid("swe-1-7")).toBe("swe-1-7");
    expect(resolveDevinModelUid("swe-1-7:medium")).toBe("swe-1-7-medium");
    expect(resolveDevinModelUid("swe-1-6")).toBe("swe-1-6");
    expect(resolveDevinModelUid("swe-1-6:fast")).toBe("swe-1-6-fast");
    expect(resolveDevinModelUid("glm-5-2")).toBe("glm-5-2");
    expect(resolveDevinModelUid("glm-5-2:none")).toBe("glm-5-2-none");
    expect(resolveDevinModelUid("glm-5-2:max")).toBe("glm-5-2-max");
    expect(resolveDevinModelUid("glm-5-2:medium")).toBe("glm-5-2");
    expect(resolveDevinModelUid("glm-5-2-1m:max")).toBe("glm-5-2-max-1m");
    expect(resolveDevinModelUid("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(resolveDevinModelUid("claude-opus-4-6:high")).toBe("claude-opus-4-6-thinking");
    expect(resolveDevinModelUid("claude-opus-4-6-1m:high")).toBe("claude-opus-4-6-thinking-1m");
    expect(resolveDevinModelUid("claude-sonnet-4-6-1m")).toBe("claude-sonnet-4-6-1m");
  });

  it("lightning tier keeps effort before the suffix", () => {
    expect(resolveDevinModelUid("swe-2-lightning")).toBe("swe-2-high-lightning");
    expect(resolveDevinModelUid("swe-2-lightning:medium")).toBe("swe-2-medium-lightning");
    expect(resolveDevinModelUid("swe-2-max-lightning")).toBe("swe-2-max-lightning");
    expect(resolveDevinModelUid("swe-2-1-lightning")).toBe("swe-2-1-high-lightning");
    expect(resolveDevinModelUid("swe-2-1-lightning:low")).toBe("swe-2-1-low-lightning");
    expect(resolveDevinModelUid("swe-2-1-max-lightning")).toBe("swe-2-1-max-lightning");
  });

  it("clamps unsupported efforts to nearest level, higher wins ties", () => {
    // glm-5-3 levels: low, high, max — medium is equidistant → high wins
    expect(resolveDevinModelUid("glm-5-3:medium")).toBe("glm-5-3-high");
    // gpt-5-4 levels: none..xhigh — max → xhigh
    expect(resolveDevinModelUid("gpt-5-4:max")).toBe("gpt-5-4-xhigh");
    // requested none on a model that lacks none → default effort
    expect(resolveDevinModelUid("claude-opus-4-7:none")).toBe("claude-opus-4-7-medium");
    // gpt-5.x families default to low
    expect(resolveDevinModelUid("gpt-5-5")).toBe("gpt-5-5-low");
    // swe-2 family defaults to high, base id preserved
    expect(resolveDevinModelUid("swe-2-flash")).toBe("swe-2-flash-high");
  });

  it("fast compound variants keep their clamped level", () => {
    // "<level>-fast" compounds come through the thinking-level argument —
    // "gpt-5-5:high-fast" would hit the known-suffix passthrough first.
    expect(resolveDevinModelUid("gpt-5-5", "high-fast")).toBe("gpt-5-5-high-fast");
    expect(resolveDevinModelUid("gpt-5-5", "medium-fast")).toBe("gpt-5-5-medium-fast");
    expect(resolveDevinModelUid("gpt-5-5", "fast")).toBe("gpt-5-5-low-fast");
  });

  it("bare non-thinking models and unknown ids pass through", () => {
    expect(resolveDevinModelUid("deepseek-v4-pro")).toBe("deepseek-v4-pro-high");
    expect(resolveDevinModelUid("totally-custom-model")).toBe("totally-custom-model");
    expect(resolveDevinModelUid("kimi-k2-6")).toBe("kimi-k2-6");
  });
});

describe("Devin SWE-2.1 model metadata", () => {
  it("is present in the native Devin catalog", () => {
    expect(DEVIN_MODELS.find((m) => m.id === "swe-2-1")).toMatchObject({
      name: "SWE-2.1",
      contextLength: 262144,
      maxCompletionTokens: 65536,
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("includes the Ultrafast lightning variant family", () => {
    expect(DEVIN_MODELS.find((m) => m.id === "swe-2-1-lightning")).toMatchObject({
      name: "SWE-2.1 Lightning",
      contextLength: 262144,
      maxCompletionTokens: 65536,
      levels: ["low", "medium", "high", "xhigh", "max"],
    });
  });

  it("publishes reasoning, vision, and token limits for base and effort ids", () => {
    const expected = {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: false,
      contextWindow: 262144,
      maxOutput: 65536,
    };
    expect(getCapabilitiesForModel("devin", "swe-2-1")).toMatchObject(expected);
    expect(getCapabilitiesForModel("devin", "swe-2-1-max")).toMatchObject(expected);
    expect(getCapabilitiesForModel("devin", "swe-2-1-lightning")).toMatchObject(expected);
  });

  it("publishes reasoning and vision for the SWE-2 family", () => {
    const expected = {
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: false,
      maxOutput: 64000,
    };
    expect(getCapabilitiesForModel("devin", "swe-2")).toMatchObject({ ...expected, contextWindow: 262000 });
    expect(getCapabilitiesForModel("devin", "swe-2-max")).toMatchObject({ ...expected, contextWindow: 262000 });
    expect(getCapabilitiesForModel("devin", "swe-2-flash")).toMatchObject({ ...expected, contextWindow: 262144 });
    expect(getCapabilitiesForModel("devin", "swe-2-lightning")).toMatchObject({ ...expected, contextWindow: 262144 });
  });

  it("advertises exactly the upstream effort levels", () => {
    expect(getThinkingLevels("devin", "swe-2-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps max reasoning effort through OpenAI normalization", () => {
    const body = { reasoning_effort: "max" };
    applyThinking("openai", "swe-2-1", body, "devin");
    expect(body.reasoning_effort).toBe("max");
  });
});

describe("hasDevinEffortSuffix / normalizeThinkingLevel", () => {
  it("recognizes known suffixes case-insensitively", () => {
    expect(hasDevinEffortSuffix("swe-2-MAX")).toBe(true);
    expect(hasDevinEffortSuffix("swe-2")).toBe(false);
    expect(hasDevinEffortSuffix("gpt-5-5-medium-fast")).toBe(true);
  });
  it("normalizes loose levels and budgets", () => {
    expect(normalizeThinkingLevel("OFF")).toBe("none");
    expect(normalizeThinkingLevel("auto")).toBe("high");
    expect(normalizeThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkingLevel("", 100)).toBe("low");
    expect(normalizeThinkingLevel("", 10000)).toBe("medium");
    expect(normalizeThinkingLevel("", 20000)).toBe("high");
    expect(normalizeThinkingLevel("", 99999)).toBe("max");
    expect(normalizeThinkingLevel("bogus")).toBe("");
  });
});
