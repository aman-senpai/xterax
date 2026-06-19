import {
  buildConfiguredLanguageModel,
  type LocalProviderConfig,
} from "@/modules/ai/lib/agent";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { getCachedConfig } from "./storage";
import { loadSignals } from "./signals";
import { storage } from "./storage";
import { refineProfile } from "./refinement";
import type { ExtractorDeps } from "./extraction";
import { usePreferencesStore } from "@/modules/settings/preferences";

import { resolveProfileModelSelection } from "./profileModel";

/**
 * Auto-refinement: triggers a profile refinement pass after a chat turn
 * if new signals have been recorded since the last refinement.
 *
 * Throttled to avoid runaway LLM calls: a minimum of
 * `minIntervalMs` between runs, and only one in-flight run at a time
 * (additional triggers during an in-flight run coalesce into a single
 * follow-up).
 *
 * Uses the user's configured refinement provider and model, falling back
 * to the active chat model when no refinement model is explicitly set.
 */

const DEFAULT_MIN_INTERVAL_MS = 5000;
const inFlight = new Map<string, Promise<void>>();
const lastRanAt = new Map<string, number>();

/**
 * Acquire the refinement lock atomically. Sets an immediate sentinel in
 * the inFlight map so concurrent callers cannot both pass the check before
 * either registers the job. Returns true if the lock was acquired.
 */
export function acquireRefineLock(
  scope: "user" | "project",
  projectRoot: string | null,
): boolean {
  const key = scopeKey(scope, projectRoot);
  if (inFlight.has(key)) return false;
  // Atomically set a sentinel — JS is single-threaded for sync code so
  // no other caller can pass the .has() check between our check and set.
  inFlight.set(key, Promise.resolve());
  return true;
}

/**
 * Register an in-flight refinement job. Call releaseRefineLock when done.
 */
export function markRefineInFlight(
  scope: "user" | "project",
  projectRoot: string | null,
  job: Promise<void>,
): void {
  const key = scopeKey(scope, projectRoot);
  inFlight.set(key, job);
  lastRanAt.set(key, Date.now());
  void job.finally(() => {
    inFlight.delete(key);
  });
}

export type AutoRefineOptions = {
  projectRoot: string | null;
  minIntervalMs?: number;
  scope?: "user" | "project";
};

export async function maybeAutoRefine(
  options: AutoRefineOptions,
): Promise<void> {
  const projectRoot = options.projectRoot ?? null;
  const scope = options.scope ?? (projectRoot ? "project" : "user");
  const key = scopeKey(scope, projectRoot);
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = Date.now();
  const last = lastRanAt.get(key) ?? 0;
  if (now - last < minInterval) return;
  if (!acquireRefineLock(scope, projectRoot)) return;
  const job = runRefine(scope, projectRoot);
  markRefineInFlight(scope, projectRoot, job);
  try {
    await job;
  } finally {
    inFlight.delete(key);
  }
}

function scopeKey(scope: "user" | "project", root: string | null): string {
  return scope === "user" ? "user" : `project:${root ?? ""}`;
}

async function runRefine(
  scope: "user" | "project",
  projectRoot: string | null,
): Promise<void> {
  const deps = makeExtractorDeps();
  try {
    await refineProfile(deps, {
      scope,
      projectRoot,
      note: "auto-refine after chat turn",
    });
  } catch (err) {
    console.warn("[engineering-profile] auto-refine failed:", err);
  }
}

/**
 * Build ExtractorDeps for the engineering profile system.
 *
 * Model resolution:
 *  1. If the user explicitly set a profile model (non-empty modelId), use it.
 *  2. Otherwise inherit from the active chat model.
 *  3. Ultimate fallback: use the first model in the MODELS list.
 */
export function makeExtractorDeps(): ExtractorDeps {
  const chat = useChatStore.getState();
  const prefs = usePreferencesStore.getState();

  const selection = resolveProfileModelSelection({
    profileProvider: prefs.profileProvider,
    profileModelId: prefs.profileModelId ?? "",
    selectedModelId: chat.selectedModelId,
    defaultModelId: prefs.defaultModelId,
    customEndpoints: prefs.customEndpoints,
    apiKeys: chat.apiKeys,
  });
  const provider = selection.provider;
  const resolvedModelId = selection.registryModelId;

  // DeepSeek thinking breaks generateObject structured extraction; chat can keep thinking on.
  const effectiveThinkingLevel =
    provider === "deepseek" ? "off" : prefs.profileThinkingLevel;

  const localConfig: LocalProviderConfig = {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    ollamaBaseURL: prefs.ollamaBaseURL,
    ollamaModelId: prefs.ollamaModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    openrouterModelId: prefs.openrouterModelId,
    customEndpoints: prefs.customEndpoints,
  };

  return {
    getKeys: () => chat.apiKeys,
    getModelId: () => resolvedModelId,
    getLocalConfig: () => localConfig,
    getConfig: () => {
      const config = getCachedConfig();
      return {
        ...config,
        provider: provider as any,
        modelId: resolvedModelId,
        thinkingLevel: effectiveThinkingLevel,
      };
    },
  };
}

/**
 * Force a refinement pass right now, bypassing the throttle. Used by the
 * AI tool `refine_profile` when the user explicitly asks.
 */
export async function forceAutoRefine(
  scope: "user" | "project",
  projectRoot: string | null,
): Promise<void> {
  const key = scopeKey(scope, projectRoot);
  lastRanAt.set(key, 0);
  await maybeAutoRefine({ projectRoot, scope });
}

export { loadSignals, storage, buildConfiguredLanguageModel };
