import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  LMSTUDIO_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
} from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { EMPTY_PROVIDER_KEYS } from "@/modules/ai/lib/keyring";
import {
  buildThinkingProviderOptions,
  DEFAULT_THINKING_LEVEL,
  type ThinkingLevel,
} from "@/modules/ai/lib/thinking";
import { generateText } from "ai";
import {
  buildUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
  type CompletionRequest,
} from "./prompt";

export type CompletionDeps = {
  provider: AutocompleteProviderId;
  modelId: string;
  apiKey: string | null;
  lmstudioBaseURL: string;
  mlxBaseURL?: string;
  ollamaBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  thinkingLevel?: ThinkingLevel;
};

const MAX_OUTPUT_TOKENS_DEFAULT = 128;
// Reasoning models burn output tokens on internal thought before producing
// any visible content; with a tight cap they finish_reason="length" with
// empty text. The trim step still caps visible output at MAX_LINES.
const MAX_OUTPUT_TOKENS_REASONING = 1024;

export async function requestCompletion(
  req: CompletionRequest,
  deps: CompletionDeps,
  signal: AbortSignal,
): Promise<string> {
  const modelId =
    deps.modelId.trim() || DEFAULT_AUTOCOMPLETE_MODEL[deps.provider] || "";
  if (!modelId) {
    throw new Error(
      `No autocomplete model id set for ${deps.provider}.`,
    );
  }
  const keys = { ...EMPTY_PROVIDER_KEYS, [deps.provider]: deps.apiKey };
  const model = await buildLanguageModel(deps.provider, keys, modelId, {
    lmstudioBaseURL: deps.lmstudioBaseURL || LMSTUDIO_DEFAULT_BASE_URL,
    mlxBaseURL: deps.mlxBaseURL,
    ollamaBaseURL: deps.ollamaBaseURL,
    openaiCompatibleBaseURL: deps.openaiCompatibleBaseURL,
  });

  // Some reasoning models need a higher output token budget to leave room for
  // internal thought before the visible completion text.
  const isReasoning = /\bgpt-oss\b/i.test(modelId);
  const isDeepSeek = deps.provider === "deepseek";
  const maxOutputTokens = isReasoning || isDeepSeek
    ? MAX_OUTPUT_TOKENS_REASONING
    : MAX_OUTPUT_TOKENS_DEFAULT;

  // Use the user's stored thinking level preference. DeepSeek thinking is
  // always disabled for autocomplete — it burns output tokens on internal
  // reasoning before producing any visible text.
  const thinkingLevel = deps.provider === "deepseek"
    ? ("off" as const)
    : (deps.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
  const providerOptions = buildThinkingProviderOptions(deps.provider, thinkingLevel, modelId);

  const { text } = await generateText({
    model,
    system: COMPLETION_SYSTEM_PROMPT,
    prompt: buildUserPrompt(req),
    maxOutputTokens,
    maxRetries: 0,
    abortSignal: signal,
    temperature: 0.2,
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  });

  return cleanCompletion(text);
}

function cleanCompletion(raw: string): string {
  let t = raw;
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");
  return t;
}
