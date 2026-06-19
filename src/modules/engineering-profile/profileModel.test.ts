import { describe, expect, it } from "vitest";
import { resolveProfileModelSelection } from "./profileModel";

describe("resolveProfileModelSelection", () => {
  it("inherits the active chat model when profileModelId is empty", () => {
    const resolved = resolveProfileModelSelection({
      profileProvider: "openai",
      profileModelId: "",
      selectedModelId: "deepseek-v4-flash",
      defaultModelId: "gpt-5.4-mini",
      apiKeys: { deepseek: "sk-deepseek", openai: null },
    });
    expect(resolved.provider).toBe("deepseek");
    expect(resolved.registryModelId).toBe("deepseek-v4-flash");
    expect(resolved.source).toBe("chat");
  });

  it("uses an explicit profile model when set", () => {
    const resolved = resolveProfileModelSelection({
      profileProvider: "deepseek",
      profileModelId: "deepseek-v4-pro",
      selectedModelId: "deepseek-v4-flash",
      defaultModelId: "gpt-5.4-mini",
      apiKeys: { deepseek: "sk-deepseek" },
    });
    expect(resolved.registryModelId).toBe("deepseek-v4-pro");
    expect(resolved.source).toBe("explicit");
  });

  it("falls back to chat when explicit provider has no API key", () => {
    const resolved = resolveProfileModelSelection({
      profileProvider: "openai",
      profileModelId: "gpt-5.4-mini",
      selectedModelId: "deepseek-v4-flash",
      defaultModelId: "gpt-5.4-mini",
      apiKeys: { deepseek: "sk-deepseek", openai: null },
    });
    expect(resolved.provider).toBe("deepseek");
    expect(resolved.source).toBe("chat");
  });

  it("uses local synthetic id for keyless profile providers", () => {
    const resolved = resolveProfileModelSelection({
      profileProvider: "ollama",
      profileModelId: "",
      selectedModelId: "deepseek-v4-flash",
      defaultModelId: "gpt-5.4-mini",
      apiKeys: {},
    });
    expect(resolved.provider).toBe("ollama");
    expect(resolved.registryModelId).toBe("ollama-local");
    expect(resolved.source).toBe("local");
  });
});