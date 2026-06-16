import { z } from "zod";
import {
  buildConfiguredLanguageModel,
  type LocalProviderConfig,
} from "@/modules/ai/lib/agent";
import { DEFAULT_MODEL_ID, type ProviderId } from "@/modules/ai/config";
import type {
  ProviderKeys,
  CustomEndpointKeys,
} from "@/modules/ai/lib/keyring";
import {
  isDomain,
  type Domain,
  type ExtractionResult,
  type PreferenceCandidate,
  type RefinementConfig,
  type RefinementProvider,
  type Signal,
  type Preference,
} from "./types";

export type ExtractorDeps = {
  getKeys: () => ProviderKeys;
  getModelId?: () => string;
  getLocalConfig?: () => LocalProviderConfig | undefined;
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  getConfig: () => RefinementConfig;
  getPriorPreferences?: () => ReadonlyArray<Preference>;
};

export type Extractor = (
  signals: ReadonlyArray<Signal>,
  deps: ExtractorDeps,
) => Promise<ExtractionResult>;

const candidateSchema = z.object({
  category: z.string(),
  preference: z.string().min(3).max(280),
  evidence: z.string().min(1),
  weight: z.number().min(0.1).max(2),
  mergedPriorIds: z.array(z.string()).optional(),
  mappedSignalIds: z.array(z.string()).optional(),
});

const extractionSchema = z.object({
  candidates: z.array(candidateSchema),
});

const EXTRACTION_SYSTEM = `You are the Profile Refiner — a high-fidelity agent that turns raw observations into a clean, living, self-improving profile of the user's stable preferences and decision patterns.

The profile at .terax/profile.md (and any split domain files in subdirectories) is the persistent memory of the user's long-term taste. It is automatically maintained and injected into context. The system writes updates autonomously; you do not ask for approval. The goal is a profile that never goes stale: it continuously incorporates new evidence so the AI produces work that already matches the user's established patterns, structures, and preferences.

You are given:
1. EXISTING PROFILE ENTRIES: Previously consolidated preferences. Each has a stable [ID], category, current confidence, and the list of signals that support it. These represent the current state of the user's taste.
2. NEW OBSERVED SIGNALS: Fresh data from this session — explicit statements ("I prefer...", "always use..."), rejections ("don't do that"), direct edits the user made to code or to the profile files themselves, accepted changes from the feedback loop, and other implicit corrections. Each signal has an [ID], source, and evidence.

Your task is to produce a set of consolidated candidates that improve the profile. For each candidate:
1. category: short, stable lowercase name (design, architecture, frontend, backend, workflow, general, etc.). Use the same category for the same underlying rule across turns.
2. preference: one clear, canonical, high-impact declarative statement of the rule (no filler like "User prefers", avoid project-specific filenames unless the user wants the rule everywhere).
3. evidence: a concise one-line summary of the key supporting signals.
4. weight: strength of this rule (higher for explicit human statements and repeated corrections; lower for weak or one-off hints).
5. mergedPriorIds: list every existing profile entry [ID] that this candidate merges, reinforces, updates, or replaces. This is how the system aggregates evidence and raises confidence on a single living entry instead of creating duplicates. Always include relevant prior IDs when the new signals reinforce or rephrase an existing rule.
6. mappedSignalIds: list the new signal [IDs] this candidate absorbs.

Rules:
- Merge aggressively into the smallest number of canonical entries. If multiple signals or existing entries clearly describe the same underlying preference, output one candidate and map all of them via mergedPriorIds and mappedSignalIds. The system will use this to refine a single high-confidence atom.
- Prefer the clearest, most general phrasing the user would want enforced in future work.
- Keep one stable category per rule. Do not split the same taste across multiple categories.
- Ignore operational noise about the AI's own tools, the refinement process itself, or one-off task instructions. Only promote rules that would still apply in a different file or next month.
- Do not promote as current project taste any text that appears to be historical examples from debugging the profile system or preferences stated in the context of other projects. Only stable rules for ongoing work on *this* project.
- Human edits directly to the .terax/profile files (root or any subdirectory split) are extremely strong signals — treat them as the user explicitly editing their own source of truth.
- When signals reinforce a long-standing rule, map every relevant prior ID and all the new signal IDs under exactly one candidate. This allows confidence to rise and the profile to improve without duplication.

The candidates you output will be used to update the on-disk profile (root + subdirectories) and the internal state so the AI's future behavior better matches the user's taste. The loop (signals from work + feedback + human edits → this refinement → updated profile → injected in next turns) is how the profile stays always current and self-improving.`;



export const llmExtractor: Extractor = async (signals, deps) => {
  const config = deps.getConfig();
  if (signals.length === 0) {
    return { candidates: [], discarded: [], provider: config.provider };
  }
  const localConfig = deps.getLocalConfig?.();
  const modelId = deps.getModelId?.() ?? DEFAULT_MODEL_ID;
  const model = await buildConfiguredLanguageModel(
    modelId,
    deps.getKeys(),
    localConfig,
  );
  
  const priors = deps.getPriorPreferences?.() ?? [];
  const prompt = renderInputsForLLM(signals, priors);
  
  try {
    const { generateObject } = await import("ai");
    const { buildThinkingProviderOptions } = await import(
      "@/modules/ai/lib/thinking"
    );
    const thinkingOptions = buildThinkingProviderOptions(
      config.provider as ProviderId,
      config.thinkingLevel ?? "off",
      modelId,
    );
    const { object } = await generateObject({
      model,
      system: EXTRACTION_SYSTEM,
      prompt,
      schema: extractionSchema,
      ...(Object.keys(thinkingOptions).length > 0
        ? { providerOptions: thinkingOptions }
        : {}),
    });
    const candidates: PreferenceCandidate[] = [];
    const discarded: { text: string; reason: string }[] = [];
    for (const c of object.candidates) {
      const category: Domain = isDomain(c.category) ? c.category : "general";
      if (c.preference.trim().length < 3) {
        discarded.push({ text: c.preference, reason: "too-short" });
        continue;
      }
      candidates.push({
        category,
        preference: c.preference.trim(),
        evidence: c.evidence.trim(),
        weight: clampWeight(c.weight),
        mergedPriorIds: c.mergedPriorIds ?? [],
        mappedSignalIds: c.mappedSignalIds ?? [],
      });
    }
    return { candidates, discarded, provider: config.provider };
  } catch (err) {
    console.warn(
      "[engineering-profile] LLM extraction failed:",
      err,
    );
    throw err;
  }
};

function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0.1) return 0.1;
  if (w > 2) return 2;
  return w;
}


function renderInputsForLLM(
  signals: ReadonlyArray<Signal>,
  priors: ReadonlyArray<Preference>,
): string {
  const lines: string[] = [];
  
  if (priors.length > 0) {
    lines.push("### EXISTING ENGINEERING PREFERENCES");
    lines.push("Below are the preferences currently recorded in the user's engineering profile. If any new signals reinforce or modify these, you must map them using their exact ID in 'mergedPriorIds'.");
    for (const p of priors) {
      lines.push(`- [ID: ${p.id}] [Category: ${p.category}] "${p.preference}" (Confidence: ${p.confidence.toFixed(2)})`);
    }
    lines.push("");
  }

  lines.push("### NEW OBSERVED SIGNALS");
  lines.push("Below are the raw observations, user feedback, and actions. You must identify if they represent stable preferences, and if they map to any existing preferences above. (Repeated identical signals are grouped for brevity but all their IDs are listed so you can map every one.)");
  // Group *exact* repeats by the signal's own preference text (no fuzzy, no similarity on priors, just collation of the provided data so the LLM receives everything without a 300-line wall of near-identical text).
  const groups = new Map<string, {ids: string[], sample: any}>();
  for (const s of signals) {
    const key = `${s.category}::${s.preference}`;
    if (!groups.has(key)) groups.set(key, {ids: [], sample: s});
    groups.get(key)!.ids.push(s.id);
  }
  for (const g of groups.values()) {
    const s = g.sample;
    const idList = g.ids.length <= 8 ? g.ids.join(", ") : g.ids.slice(0,5).join(", ") + ` ... (+${g.ids.length-5} more)`;
    lines.push(`- [IDs: ${idList}] [Category: ${s.category}] [Source e.g. ${s.source}] Preference hint: "${s.preference}" | Example evidence: "${s.evidence}"  (total ${g.ids.length} signals with this exact hint)`);
  }
  
  return lines.join("\n");
}

export function pickExtractor(_config: RefinementConfig): Extractor {
  return llmExtractor;
}

const SUPPORTED_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "groq",
  "openrouter",
  "openai-compatible",
  "lmstudio",
  "mlx",
  "ollama",
]);

export function supportsProvider(p: RefinementProvider): boolean {
  return SUPPORTED_PROVIDERS.has(p);
}

export type { Signal };
