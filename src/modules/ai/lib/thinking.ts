import type { ProviderId } from "../config";

export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export const THINKING_LEVELS: readonly {
  value: ThinkingLevel;
  label: string;
  hint: string;
}[] = [
  { value: "off", label: "Off", hint: "No extended thinking" },
  { value: "low", label: "Low", hint: "Minimal reasoning budget" },
  { value: "medium", label: "Medium", hint: "Balanced reasoning" },
  { value: "high", label: "High", hint: "Deep reasoning" },
  { value: "max", label: "Max", hint: "Maximum reasoning budget" },
] as const;

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "off";

/** Providers that support some form of thinking/reasoning configuration. */
const THINKING_PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "openai",
  "anthropic",
  "google",
  "xai",
  "cerebras",
  "groq",
  "deepseek",
  "openrouter",
  "openai-compatible",
]);

export function supportsThinkingLevel(provider: ProviderId): boolean {
  return THINKING_PROVIDERS.has(provider);
}

/** Returns the set of thinking levels applicable to a provider. */
export function getThinkingLevels(
  provider: ProviderId,
): readonly { value: ThinkingLevel; label: string; hint: string }[] {
  if (!supportsThinkingLevel(provider)) return [];
  if (provider === "deepseek") {
    // DeepSeek only supports off / high / max.
    // "low" and "medium" are mapped to "high" server-side.
    return THINKING_LEVELS.filter((l) =>
      l.value === "off" || l.value === "high" || l.value === "max",
    );
  }
  return THINKING_LEVELS;
}

/** Anthropic models that support adaptive thinking (type: "adaptive" + effort). */
const ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-mythos-5",
]);

/** Build provider-specific thinking options for `streamText`/`generateText`. */
export function buildThinkingProviderOptions(
  provider: ProviderId,
  level: ThinkingLevel,
  modelId?: string,
): Record<string, Record<string, string | number | Record<string, string | number>>> {
  if (!supportsThinkingLevel(provider) || level === "off") {
    if (provider === "deepseek") {
      return { deepseek: { thinking: { type: "disabled" } } };
    }
    return {};
  }

  switch (provider) {
    // ── Reasoning-effort providers ──────────────────────────────────────
    case "openai":
    case "xai":
    case "cerebras":
    case "groq":
    case "openrouter":
    case "openai-compatible": {
      const effort: string = level === "max" ? "high" : level;
      return { [provider]: { reasoningEffort: effort } };
    }

    // ── Anthropic adaptive / manual thinking ────────────────────────────
    // Adaptive: Opus 4.6+, Sonnet 4.6+. Manual budget_tokens is deprecated
    // on Opus 4.6/Sonnet 4.6, rejected on Opus 4.7/4.8.
    case "anthropic": {
      if (modelId && ADAPTIVE_THINKING_MODELS.has(modelId)) {
        const effort = level === "max" ? "max" : level;
        return {
          anthropic: {
            thinking: { type: "adaptive" },
            output_config: { effort },
          },
        };
      }
      // Older models (Haiku 4.5, etc.) — manual budget_tokens only.
      const budgetTokens = thinkingBudgetForLevel(level);
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens },
        },
      };
    }

    // ── Google thinking config ──────────────────────────────────────────
    case "google": {
      const thinkingBudget = thinkingBudgetForLevel(level);
      return {
        google: {
          thinkingConfig: { thinkingBudget },
        },
      };
    }

    // ── DeepSeek thinking + reasoning_effort ─────────────────────────────
    case "deepseek": {
      const effort: string = level === "max" ? "max" : "high";
      return {
        deepseek: {
          thinking: { type: "enabled" },
          reasoning_effort: effort,
        },
      };
    }

    default:
      return {};
  }
}

function thinkingBudgetForLevel(level: ThinkingLevel): number {
  switch (level) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "max":
      return 16384;
    default:
      return 4096;
  }
}
