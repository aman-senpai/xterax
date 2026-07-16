import { describe, expect, it } from "vitest";
import {
  applyThoughtToModelId,
  deriveThoughtOptionFromModel,
  findMatchingOption,
  flattenSelectOptions,
  isOptionSelected,
  mergeSessionConfig,
  modelIdAfterThoughtChange,
  optionCurrentLabel,
  parseConfigOptions,
  parseModes,
  parseSessionModels,
  slotConfigOptions,
  thoughtLevelFromModelId,
} from "./configOptions";

describe("parseConfigOptions", () => {
  it("parses agent-style mode + model payload", () => {
    const opts = parseConfigOptions([
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "agent",
        options: [
          { value: "agent", name: "Agent" },
          { value: "plan", name: "Plan" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "claude-sonnet-4-6[thinking=true]",
        options: [
          {
            value: "claude-sonnet-4-6[thinking=true]",
            name: "claude-sonnet-4-6",
          },
          { value: "claude-opus-4-6[]", name: "claude-opus-4-6" },
        ],
      },
    ]);
    expect(opts).toHaveLength(2);
    const slots = slotConfigOptions(opts, null);
    expect(slots.mode?.currentValue).toBe("agent");
    expect(slots.model?.options).toHaveLength(2);
    expect(optionCurrentLabel(slots.model!)).toBe("claude-sonnet-4-6");
  });

  it("flattens nested option groups like claude-agent-acp", () => {
    const flat = flattenSelectOptions([
      {
        name: "Recommended",
        options: [
          { value: "default", name: "Default (recommended)" },
          { value: "deepseek-v4-pro[1m]", name: "deepseek-v4-pro[1m]" },
        ],
      },
      { value: "deepseek-v4-flash", name: "deepseek-v4-flash" },
    ]);
    expect(flat).toHaveLength(3);
    expect(flat.map((f) => f.value)).toEqual([
      "default",
      "deepseek-v4-pro[1m]",
      "deepseek-v4-flash",
    ]);
  });

  it("dedupes by value", () => {
    const flat = flattenSelectOptions([
      { value: "a", name: "A" },
      { value: "a", name: "A again" },
      { value: "b", name: "B" },
    ]);
    expect(flat).toHaveLength(2);
  });
});

describe("parseSessionModels", () => {
  it("maps Claude ACP top-level models field", () => {
    const model = parseSessionModels({
      currentModelId: "deepseek-v4-pro[1m]",
      availableModels: [
        {
          modelId: "default",
          name: "Default (recommended)",
          description: "Use the default model",
        },
        {
          modelId: "deepseek-v4-pro[1m]",
          name: "deepseek-v4-pro[1m]",
        },
        {
          modelId: "deepseek-v4-flash",
          name: "deepseek-v4-flash",
        },
      ],
    });
    expect(model?.category).toBe("model");
    expect(model?.currentValue).toBe("deepseek-v4-pro[1m]");
    expect(model?.options).toHaveLength(3);
    expect(optionCurrentLabel(model!)).toBe("deepseek-v4-pro[1m]");
  });
});

describe("mergeSessionConfig", () => {
  it("prefers top-level models over configOptions model list", () => {
    const { configOptions } = mergeSessionConfig(
      [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "stale",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
            { value: "haiku", name: "Haiku" },
          ],
        },
      ],
      null,
      {
        currentModelId: "deepseek-v4-pro[1m]",
        availableModels: [
          { modelId: "default", name: "Default (recommended)" },
          { modelId: "deepseek-v4-pro[1m]", name: "deepseek-v4-pro[1m]" },
        ],
      },
    );
    const slots = slotConfigOptions(configOptions, null);
    expect(slots.model?.options?.map((o) => o.value)).toEqual([
      "default",
      "deepseek-v4-pro[1m]",
    ]);
    expect(slots.model?.currentValue).toBe("deepseek-v4-pro[1m]");
    expect(slots.mode?.currentValue).toBe("default");
  });
});

describe("selection matching", () => {
  it("resolves short aliases to full model ids", () => {
    const options = [
      { value: "claude-haiku-4-5[thinking=true]", name: "Haiku" },
      { value: "claude-sonnet-4-6[thinking=true]", name: "Sonnet" },
    ];
    const match = findMatchingOption(options, "haiku");
    expect(match?.name).toBe("Haiku");
    expect(
      isOptionSelected(
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "haiku",
          options,
        },
        "claude-haiku-4-5[thinking=true]",
      ),
    ).toBe(true);
  });
});

describe("parseModes", () => {
  it("accepts snake_case", () => {
    const modes = parseModes({
      current_mode_id: "ask",
      available_modes: [
        { id: "ask", name: "Ask" },
        { id: "code", name: "Code" },
      ],
    });
    expect(modes?.currentModeId).toBe("ask");
    expect(modes?.availableModes).toHaveLength(2);
  });
});

describe("model-id thought derivation", () => {
  it("reads effort/thinking from Claude model ids", () => {
    expect(
      thoughtLevelFromModelId(
        "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]",
      ),
    ).toBe("medium");
    expect(
      thoughtLevelFromModelId("claude-sonnet-4[thinking=false,context=200k]"),
    ).toBe("off");
  });

  it("writes effort back into the model id", () => {
    const next = applyThoughtToModelId(
      "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]",
      "high",
    );
    expect(next).toContain("thinking=true");
    expect(next).toContain("effort=high");
    expect(next).toContain("context=200k");
  });

  it("derives a thought slot when agent only ships mode+model", () => {
    const model = {
      id: "model",
      name: "Model",
      category: "model" as const,
      type: "select",
      currentValue: "claude-sonnet-4-6[thinking=true,effort=medium]",
      options: [
        {
          value: "claude-sonnet-4-6[thinking=true,effort=medium]",
          name: "Sonnet",
        },
        {
          value: "claude-haiku-4-5[thinking=true,effort=low]",
          name: "Haiku",
        },
      ],
    };
    const thought = deriveThoughtOptionFromModel(model);
    expect(thought?.currentValue).toBe("medium");
    expect(thought?.options?.map((o) => o.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);

    const slots = slotConfigOptions(
      [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
        model,
      ],
      null,
    );
    expect(slots.thoughtFromModel).toBe(true);
    expect(slots.thought?.id).toBe("__model_thought__");

    const rewritten = modelIdAfterThoughtChange(model, "off");
    // Off strips thinking/effort params (clean id when nothing else remains)
    expect(rewritten).not.toContain("thinking=");
    expect(rewritten).not.toContain("effort=");
  });

  it("still offers a clickable thought control for models without params", () => {
    const thought = deriveThoughtOptionFromModel({
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "deepseek-v4-pro[1m]",
      options: [
        { value: "deepseek-v4-pro[1m]", name: "deepseek-v4-pro[1m]" },
        { value: "deepseek-v4-flash", name: "deepseek-v4-flash" },
      ],
    });
    expect(thought?.currentValue).toBe("off");
    expect(thought?.options?.length).toBe(5);
    // Turning thinking on preserves bare context tokens like [1m]
    expect(modelIdAfterThoughtChange(
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: "deepseek-v4-pro[1m]",
      },
      "high",
    )).toBe("deepseek-v4-pro[1m,thinking=true,effort=high]");
  });
});
