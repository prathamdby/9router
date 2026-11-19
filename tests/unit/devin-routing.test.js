import { describe, it, expect } from "vitest";
import { AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseModel } from "open-sse/services/model.js";
import { getExecutor } from "open-sse/executors/index.js";
import { DevinExecutor } from "open-sse/executors/devin.js";

describe("devin routing", () => {
  it("resolves the dashboard model prefix to the native Devin executor", () => {
    const uiAlias = AI_PROVIDERS.devin.alias;
    const { provider } = parseModel(`${uiAlias}/swe-2`);
    expect(provider).toBe("devin");
    expect(getExecutor(provider)).toBeInstanceOf(DevinExecutor);
  });
});
