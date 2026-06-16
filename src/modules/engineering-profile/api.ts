import { storage, getCachedConfig } from "./storage";
import { refineProfile, rollbackTo, type RefineResult } from "./refinement";
import {
  buildContextPackage,
  classifyTask,
  explainPreference,
  loadProfiles,
  renderContextPackageForPrompt,
  type ContextPackage,
  type PreferenceExplanation,
} from "./runtime";
import {
  DEFAULT_REFINEMENT_CONFIG,
  type LoadedProfiles,
  type Preference,
  type Profile,
  type ProfileSnapshot,
  type RefinementConfig,
  type Scope,
  type Signal,
} from "./types";
import type { ExtractorDeps } from "./extraction";
import {
  recordAcceptedChange,
  recordArchitectureDecision,
  recordConfigSetting,
  recordDesignCritique,
  recordExplicitFeedback,
  recordRecurringRequest,
  recordRejectedChange,
  recordSignal,
  recordSignals,
  recordUserModification,
  recordWorkflowInstruction,
  type RecordSignalInput,
  type RecordSignalResult,
} from "./signals";
import { useChatStore } from "@/modules/ai/store/chatStore";

export type GetProfileOptions = {
  scope?: Scope;
  projectRoot?: string | null;
  merged?: boolean;
};

export async function getProfile(
  opts: GetProfileOptions = {},
): Promise<Profile> {
  const scope = opts.scope ?? "user";
  const root = opts.projectRoot ?? null;
  const profile = await storage.getProfile(scope, root);
  if (profile) return profile;
  return scope === "user"
    ? makeEmpty("user", null)
    : makeEmpty("project", root);
}

export async function getMergedProfile(
  projectRoot: string | null,
): Promise<Profile> {
  const loaded = await loadProfiles(projectRoot);
  return mergeInto(loaded);
}

function mergeInto(loaded: LoadedProfiles): Profile {
  const now = Date.now();
  if (!loaded.project) return loaded.user;
  const merged = new Map<string, Preference>();
  for (const up of loaded.user.preferences) {
    merged.set(keyOf(up), { ...up });
  }
  for (const pp of loaded.project.preferences) {
    const k = keyOf(pp);
    const userPref = merged.get(k);
    if (!userPref) {
      merged.set(k, { ...pp });
    } else {
      merged.set(k, { ...pp, confidence: Math.max(userPref.confidence, pp.confidence) });
    }
  }
  const list = Array.from(merged.values()).sort(
    (a, b) => b.confidence - a.confidence,
  );
  return {
    ...loaded.user,
    projectRoot: loaded.project.projectRoot,
    preferences: list,
    generatedAt: now,
  };
}

function keyOf(p: Preference): string {
  return `${p.category}::${p.preference.toLowerCase()}`;
}

function makeEmpty(scope: Scope, projectRoot: string | null): Profile {
  return {
    id: "empty",
    scope,
    projectRoot,
    generatedAt: Date.now(),
    summary: "",
    preferences: [],
    domains: {},
  };
}

export async function refineUserProfile(
  deps: ExtractorDeps,
  opts?: { now?: number; note?: string | null },
): Promise<RefineResult> {
  return refineProfile(deps, {
    scope: "user",
    projectRoot: null,
    now: opts?.now,
    note: opts?.note ?? null,
  });
}

export async function refineProjectProfile(
  deps: ExtractorDeps,
  projectRoot: string,
  opts?: { now?: number; note?: string | null },
): Promise<RefineResult> {
  return refineProfile(deps, {
    scope: "project",
    projectRoot,
    now: opts?.now,
    note: opts?.note ?? null,
  });
}

export async function rollbackProfile(
  snapshotId: string,
  scope: Scope,
  projectRoot: string | null,
): Promise<RefineResult | null> {
  return rollbackTo(snapshotId, scope, projectRoot);
}

export async function showProfileHistory(
  scope: Scope,
  projectRoot: string | null,
  limit = 20,
): Promise<ProfileSnapshot[]> {
  const list = await storage.loadSnapshots(scope, projectRoot);
  return list.slice(-limit).reverse();
}

export async function showSignals(
  scope: Scope,
  projectRoot: string | null,
  limit = 100,
): Promise<Signal[]> {
  const list = await storage.loadSignals(scope, projectRoot);
  return list.slice(-limit).reverse();
}

export async function listProjectProfiles(): Promise<
  { root: string; profile: Profile }[]
> {
  return storage.listProjectProfiles();
}

export async function getRefinementConfig(): Promise<RefinementConfig> {
  const stored = await storage.getConfig();
  if (!stored) return { ...DEFAULT_REFINEMENT_CONFIG };
  return { ...DEFAULT_REFINEMENT_CONFIG, ...(stored as Partial<RefinementConfig>) };
}

export async function setRefinementConfig(
  config: Partial<RefinementConfig>,
): Promise<RefinementConfig> {
  const current = await getRefinementConfig();
  const next = { ...current, ...config };
  await storage.saveConfig(next);
  return next;
}

export type { ContextPackage, PreferenceExplanation };

export {
  classifyTask,
  buildContextPackage,
  renderContextPackageForPrompt,
  explainPreference,
  loadProfiles,
  recordSignal,
  recordSignals,
  recordAcceptedChange,
  recordRejectedChange,
  recordUserModification,
  recordArchitectureDecision,
  recordRecurringRequest,
  recordDesignCritique,
  recordWorkflowInstruction,
  recordConfigSetting,
  recordExplicitFeedback,
};

export type { RecordSignalInput, RecordSignalResult };

export type EngineeringProfileDeps = ExtractorDeps;

/**
 * Default deps bound to the live chat store. Use this in any call site
 * that doesn't have its own (e.g. AI tools). For advanced cases (custom
 * refinement, alternate providers), pass a fully formed deps object.
 */
export function defaultDeps(): EngineeringProfileDeps {
  const chat = useChatStore.getState();
  return {
    getKeys: () => chat.apiKeys,
    getModelId: () => chat.selectedModelId,
    getLocalConfig: () => undefined,
    getConfig: () => getCachedConfig(),
  };
}

export const _internal = { keyOf, makeEmpty };
