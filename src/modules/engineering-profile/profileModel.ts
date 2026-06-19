import {
  getModel,
  isCompatModelId,
  isKnownModelId,
  MODELS,
  providerNeedsKey,
  resolveModel,
  type CustomEndpoint,
  type ModelId,
  type ProviderId,
} from "@/modules/ai/config";
import type { RefinementProvider } from "./types";

export type ProfileModelSource = "explicit" | "local" | "chat" | "fallback";

export type ResolvedProfileModel = {
  provider: ProviderId;
  registryModelId: string;
  source: ProfileModelSource;
};

export type ProfileModelSelectionInput = {
  profileProvider: RefinementProvider;
  profileModelId: string;
  selectedModelId: string | null;
  defaultModelId: string;
  customEndpoints?: readonly CustomEndpoint[];
  apiKeys: Partial<Record<ProviderId, string | null>>;
};

/**
 * Resolves which provider/model powers engineering-profile LLM calls
 * (intent observation + refinement extraction).
 *
 * When profileModelId is empty, inherits the active chat model — the
 * Engineering profile picker only overrides when a specific model is chosen.
 */
export function resolveProfileModelSelection(
  input: ProfileModelSelectionInput,
): ResolvedProfileModel {
  const explicitModelId = input.profileModelId.trim();
  const endpoints = input.customEndpoints ?? [];

  if (explicitModelId) {
    const resolved = modelFromRegistryId(
      explicitModelId,
      endpoints,
      "explicit",
    );
    if (resolved) return withKeyFallback(resolved, input);
  }

  if (
    input.profileProvider &&
    !providerNeedsKey(input.profileProvider as ProviderId)
  ) {
    return {
      provider: input.profileProvider as ProviderId,
      registryModelId: `${input.profileProvider}-local`,
      source: "local",
    };
  }

  const chat = pickChatModel(input);
  if (chat) return chat;

  const fallback = MODELS[0]!;
  return {
    provider: fallback.provider,
    registryModelId: fallback.id,
    source: "fallback",
  };
}

function withKeyFallback(
  resolved: ResolvedProfileModel,
  input: ProfileModelSelectionInput,
): ResolvedProfileModel {
  if (
    providerNeedsKey(resolved.provider) &&
    !input.apiKeys[resolved.provider]
  ) {
    const chat = pickChatModel(input);
    if (chat && input.apiKeys[chat.provider]) return chat;
  }
  return resolved;
}

function pickChatModel(
  input: ProfileModelSelectionInput,
): ResolvedProfileModel | null {
  const activeId = input.selectedModelId || input.defaultModelId;
  if (!activeId) return null;
  const resolved = modelFromRegistryId(
    activeId,
    input.customEndpoints ?? [],
    "chat",
  );
  if (!resolved) return null;
  if (
    providerNeedsKey(resolved.provider) &&
    !input.apiKeys[resolved.provider]
  ) {
    return null;
  }
  return resolved;
}

function modelFromRegistryId(
  id: string,
  endpoints: readonly CustomEndpoint[],
  source: ProfileModelSource,
): ResolvedProfileModel | null {
  for (const candidate of modelIdCandidates(id)) {
    const info = lookupRegistryModel(candidate, endpoints);
    if (info) {
      return {
        provider: info.provider,
        registryModelId: info.id,
        source,
      };
    }
  }
  return null;
}

function modelIdCandidates(id: string): string[] {
  const out = [id];
  const colon = id.indexOf(":");
  if (colon > 0) {
    const tail = id.slice(colon + 1);
    if (tail && !out.includes(tail)) out.push(tail);
  }
  return out;
}

function lookupRegistryModel(
  id: string,
  endpoints: readonly CustomEndpoint[],
):
  | { provider: ProviderId; id: string }
  | null {
  try {
    if (isCompatModelId(id)) {
      const info = resolveModel(id, endpoints);
      return { provider: info.provider, id: info.id };
    }
    if (isKnownModelId(id)) {
      const info = getModel(id as ModelId);
      return { provider: info.provider, id: info.id };
    }
  } catch {
    return null;
  }
  return null;
}