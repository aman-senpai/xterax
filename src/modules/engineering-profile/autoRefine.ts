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

/**
 * Auto-refinement: triggers a profile refinement pass after a chat turn
 * if new signals have been recorded since the last refinement.
 *
 * Throttled to avoid runaway LLM calls: a minimum of
 * `minIntervalMs` between runs, and only one in-flight run at a time
 * (additional triggers during an in-flight run coalesce into a single
 * follow-up).
 *
 * Uses the user's configured LLM provider and model, falling back to the
 * heuristic extractor if the LLM call fails.
 */

const DEFAULT_MIN_INTERVAL_MS = 5000;
const inFlight = new Map<string, Promise<void>>();
const lastRanAt = new Map<string, number>();

export type AutoRefineOptions = {
  projectRoot: string | null;
  minIntervalMs?: number;
  scope?: "user" | "project";
};

export async function maybeAutoRefine(
  options: AutoRefineOptions,
): Promise<void> {
  const scope = options.scope ?? "user";
  const projectRoot = options.projectRoot ?? null;
  const key = scopeKey(scope, projectRoot);
  const minInterval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = Date.now();
  const last = lastRanAt.get(key) ?? 0;
  if (now - last < minInterval) return;
  if (inFlight.has(key)) return;
  const job = runRefine(scope, projectRoot);
  inFlight.set(key, job);
  lastRanAt.set(key, now);
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

function makeExtractorDeps(): ExtractorDeps {
  const chat = useChatStore.getState();
  const localConfig: LocalProviderConfig | undefined = undefined;
  return {
    getKeys: () => chat.apiKeys,
    getModelId: () => chat.selectedModelId,
    getLocalConfig: () => localConfig,
    getConfig: () => getCachedConfig(),
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
