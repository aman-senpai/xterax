import { DEFAULT_MODEL_ID, type ProviderId } from "@/modules/ai/config";
import {
  buildConfiguredLanguageModel,
  type LocalProviderConfig,
} from "@/modules/ai/lib/agent";
import type {
  CustomEndpointKeys,
  ProviderKeys,
} from "@/modules/ai/lib/keyring";
import { z } from "zod";
import {
  type Domain,
  type ExtractionResult,
  isDomain,
  type Preference,
  type PreferenceCandidate,
  type RefinementConfig,
  type Signal,
  supportsProvider,
} from "./types";

export type ExtractorDeps = {
  getKeys: () => ProviderKeys;
  getModelId?: () => string;
  getLocalConfig?: () => LocalProviderConfig | undefined;
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  getConfig: () => RefinementConfig;
  getPriorPreferences?: () => ReadonlyArray<Preference>;
  currentProjectRoot?: string | null;
};

export type Extractor = (
  signals: ReadonlyArray<Signal>,
  deps: ExtractorDeps,
) => Promise<ExtractionResult>;

const candidateSchema = z.object({
  category: z.string(),
  preference: z.string().min(3).max(280),
  precision: z.number().min(0).max(1).optional(), // optional: DeepSeek may omit
  evidence: z.string().min(1),
  weight: z.number().min(0.1).max(2),
  mergedPriorIds: z.array(z.string()).optional(),
  mappedSignalIds: z.array(z.string()).optional(),
});

const extractionSchema = z.object({
  candidates: z.array(candidateSchema),
});

const EXTRACTION_SYSTEM = `You are the Profile Refiner — you distill raw user observations into precise, actionable behavior rules. Your output becomes the AI's instruction manual, injected into context on every turn.

You do NOT transcribe what the user said. You extract the underlying behavior rule: what should the AI DO or AVOID, specifically and concretely, in future work?

## The distillation principle

Observations are raw: "I don't like that", "Don't use multi_edit that way", "Mujhe clean code pasand hai"

Behavior rules are distilled: "Prefer edit for localized code modifications; reserve multi_edit for coordinated changes spanning multiple regions."

Every candidate you output must be a behavior rule an AI can execute without additional context.

## What a behavior rule looks like

GOOD (specific, actionable, context-independent):
- "Prefer small single-purpose functions over large multifunction methods."
- "Keep React components below 300 lines; split larger components into composable sub-components."
- "Use optimistic updates for user-facing mutations when rollback is feasible."
- "Trace issues through the complete execution path instead of validating individual components in isolation."
- "Avoid mutating external store objects in place when using React Compiler; preserve referential changes to ensure re-render propagation."

BAD (abstract, vague, useless — NEVER output these):
- "Write clean code" — what does "clean" mean? Reject.
- "Use best practices" — meaningless. Reject.
- "Make it scalable" — how? Reject.
- "Improve UX" — in what way? Reject.
- "I prefer clean code" — just an opinion, not a rule. Reject.
- "Don't use multi_edit that way" — what way? What instead? Distill further.
- "Handle errors properly" — which approach? Reject.

If you cannot distill a concrete, actionable behavior rule from the available signals, output nothing. A vague preference is worse than no preference — it pollutes the profile.

## FORMAT

For each candidate:

1. **category**: A stable, descriptive lowercase name. Use the SAME category for the SAME rule across turns so confidence accumulates. Create domain-specific names freely: "coding-style", "react", "swift", "database", "api-design", "debugging", "testing", "git", "tool-usage", "ux", "communication", "performance". Do NOT default to "general" — find the right domain.

2. **preference**: ONE self-contained, actionable behavior rule. Must include the WHAT, the HOW, and the WHY. Concrete technique/API/tool names over abstract advice. An AI reading only this line must know exactly what to do.

3. **precision** (0.0–1.0): How precisely is this rule understood? NOT how many times it was repeated — how unambiguous and concrete is the interpretation itself?
   - 0.9–1.0: Crystal clear. The rule names specific techniques, tools, and conditions. No ambiguity.
   - 0.7–0.89: Well-understood. The direction is clear but some details could be sharper.
   - 0.4–0.69: Interpreted from weak or ambiguous signals. The gist is there but the specifics are inferred.
   - 0.1–0.39: Highly uncertain interpretation. The signal was vague and the rule is a best guess.

4. **evidence**: One-line summary of the key signals.

5. **weight** (0.1–2.0): How strongly the user feels about this, independent of precision. Higher for explicit directives (1.0+) and corrections (1.2+). Lower for one-off hints (0.3–0.5).

6. **mergedPriorIds**: List every existing profile entry [ID] this candidate merges, reinforces, or replaces.

7. **mappedSignalIds**: List the new signal [IDs] this candidate absorbs.

## RULES

- **Distill, don't transcribe.** Turn "Don't use X" into "Prefer Y for Z; reserve X for W". Turn "I like clean code" into specific coding standards inferred from context.
- **Be specific or be silent.** If you can't produce a concrete, actionable behavior rule, output nothing. Vague output pollutes the profile.
- **Infer the positive rule from rejections.** Every "don't do X" implies a "do Y instead". State the positive.
- **Merge aggressively.** Same underlying rule → one candidate with all IDs mapped.
- **Stable categories.** Same rule across turns = same category name so confidence accumulates.
- **Domain-specific categories.** "swift", "react", "database", "api-design" — not "general".
- **Human edits to .xterax/profile.md are ground truth.** Treat them as explicit corrections with maximum precision (0.95+).

## DEDUPLICATION AND CLEANUP (you are solely responsible)

You are the only consolidation step. No local fuzzy matching runs after you.

1. **Semantic duplicates → one candidate.** "I prefer clean code", "I prefer clear code", "clean readable code", and Hindi/Hinglish equivalents (e.g. "Mujhe clean code pasand hai") are ONE intent. Output a single English behavior rule and list every related signal ID and every related prior ID in mergedPriorIds / mappedSignalIds.

2. **Cross-category duplicates → one category.** If the same intent appears under "general" and "code-quality", pick the best domain (usually code-quality, not general) and merge all IDs into one candidate.

3. **Non-English signals → English rules only.** Never output Hindi, Hinglish, or other languages in the preference field. Translate to one distilled English behavior rule.

4. **Drop meta-noise entirely — output no candidate.** Ignore and do not carry forward:
   - "User edited /path/to/.xterax: user edited file" or any filesystem path edit summaries
   - Raw chat transcripts that are not enduring preferences
   - Vague opinions you cannot distill ("I prefer clean code" with no inferable specifics → output nothing unless you can infer concrete standards from other signals in the batch)

5. **Prune stale priors.** If an existing preference [ID] is redundant with a new distilled rule, superseded, meta-noise, or a non-English duplicate of an English rule, include its ID in mergedPriorIds of the replacement candidate. Priors you do not merge and that are noise should simply be omitted from your output so they are not carried forward.`;


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
  const prompt = renderInputsForLLM(
    signals,
    priors,
    deps.currentProjectRoot ?? null,
  );

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
        precision: clampPrecision(c.precision),
        evidence: c.evidence.trim(),
        weight: clampWeight(c.weight),
        mergedPriorIds: c.mergedPriorIds ?? [],
        mappedSignalIds: c.mappedSignalIds ?? [],
      });
    }
    return { candidates, discarded, provider: config.provider };
  } catch (err) {
    console.warn("[engineering-profile] LLM extraction failed:", err);
    return { candidates: [], discarded: [], provider: config.provider };
  }
};

function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0.1) return 0.1;
  if (w > 2) return 2;
  return w;
}

function clampPrecision(p: number | undefined): number {
  if (p === undefined || Number.isNaN(p)) return 0.5;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

function renderInputsForLLM(
  signals: ReadonlyArray<Signal>,
  priors: ReadonlyArray<Preference>,
  currentProjectRoot: string | null,
): string {
  const lines: string[] = [];

  if (currentProjectRoot) {
    lines.push(
      `Current project root for this refinement: ${currentProjectRoot}`,
    );
    lines.push(
      "Only produce or keep preferences that are relevant to ongoing work inside this specific directory tree. Aggressively drop or ignore any priors or signals that are clearly about a different codebase (e.g. 'resume' or 'CV' rules when the root path does not contain it).",
    );
    lines.push("");
  }

  if (priors.length > 0) {
    lines.push("### EXISTING ENGINEERING PREFERENCES");
    lines.push(
      "Below are the preferences currently recorded in the user's engineering profile for *this* project. If any new signals reinforce or modify these, you must map them using their exact ID in 'mergedPriorIds'. Drop any that do not belong here.",
    );
    for (const p of priors) {
      lines.push(
        `- [ID: ${p.id}] [Category: ${p.category}] "${p.preference}" (Confidence: ${p.confidence.toFixed(2)})`,
      );
    }
    lines.push("");
  }

  lines.push("### NEW OBSERVED SIGNALS");
  lines.push(
    "Below are the raw observations, user feedback, and actions for this project. You must identify if they represent stable preferences, and if they map to any existing preferences above. (Repeated identical signals are grouped for brevity but all their IDs are listed so you can map every one.)",
  );
  // Group *exact* repeats by the signal's own preference text (no fuzzy, no similarity on priors, just collation of the provided data so the LLM receives everything without a 300-line wall of near-identical text).
  const groups = new Map<string, { ids: string[]; sample: any }>();
  for (const s of signals) {
    const key = `${s.category}::${s.preference}`;
    if (!groups.has(key)) groups.set(key, { ids: [], sample: s });
    groups.get(key)!.ids.push(s.id);
  }
  for (const g of groups.values()) {
    const s = g.sample;
    const idList =
      g.ids.length <= 8
        ? g.ids.join(", ")
        : g.ids.slice(0, 5).join(", ") + ` ... (+${g.ids.length - 5} more)`;
    lines.push(
      `- [IDs: ${idList}] [Category: ${s.category}] [Source e.g. ${s.source}] Preference hint: "${s.preference}" | Example evidence: "${s.evidence}"  (total ${g.ids.length} signals with this exact hint)`,
    );
  }

  return lines.join("\n");
}

export function pickExtractor(_config: RefinementConfig): Extractor {
  return llmExtractor;
}

// ── Profile-level refinement (post-merge cleanup) ──────────────────────

const profileRefinementSchema = z.object({
  actions: z.array(
    z.object({
      targetId: z.string(),
      action: z.enum(["keep", "merge", "drop", "strengthen", "translate"]),
      preference: z.string().min(3).max(280).optional(),
      confidence: z.number().min(0).max(1).optional(),
      mergedSourceIds: z.array(z.string()).optional(),
      reason: z.string().min(1).optional(),
    }),
  ),
});

const PROFILE_REFINEMENT_SYSTEM = `You are the Profile Quality Refiner. You review the assembled engineering profile and clean it up. Unlike the extractor (which distills raw signals into candidates), your job is to audit the FINAL profile output for quality issues.

## What you MUST fix

1. **Semantic duplicates.** Two or more preferences that express the SAME underlying rule with different wording → merge into the best-phrased version. Examples:
   - "Prefer clean, readable code" and "Write clear, clean code" → ONE rule: "Prefer clean, readable code with descriptive naming"
   - "Use small functions" and "Keep functions short" → ONE rule
   - Merge ALL duplicate IDs into mergedSourceIds of the survivor.

2. **Non-English leakage.** If any preference contains Hindi, Hinglish, Urdu, or any non-English text → translate to English. Set action: "translate". The profile is read by English-language coding agents.

3. **Vague/generic preferences that survived extraction.** Rules like "Write clean code" (without specifics) or "Use best practices" (without which practices) → either strengthen with concrete specifics inferred from context, or drop them. A rule that says only "Prefer clean code" with no technique names, no conditions, no alternatives is noise.

4. **Redundant cross-category entries.** The same rule appearing under both "general" and "code-quality" → keep it under the more specific domain, mark the other for drop.

## What you MUST NOT change

- Preferences with confidence ≥ 0.85 AND concrete technique names — these are well-understood. Keep them.
- Pinned preferences (marked with [pinned]) — the user explicitly locked these.
- Anything you're unsure about — err on the side of keeping.

## Output format

For EACH preference in the profile that needs action:
- targetId: the existing preference ID
- action: "keep" (no change needed), "merge" (fold into another preference — list the survivor's ID in mergedSourceIds), "drop" (remove entirely), "strengthen" (rewrite to be more concrete), "translate" (convert non-English to English)
- preference: the cleaned/replacement text (for strengthen/translate/merge actions)
- confidence: adjusted confidence (for merge: weighted average; for strengthen: bump by 0.05-0.1; for translate: unchanged)
- mergedSourceIds: list of preference IDs this preference absorbs (for merge action on the SURVIVOR only)
- reason: one-line explanation

Only output actions for preferences that need changes. Preferences you leave as "keep" don't need an entry unless you want to explicitly confirm them.`;

/** Post-merge LLM cleanup of the assembled profile. Runs after candidate
 *  merge to catch remaining semantic duplicates, non-English leakage, and
 *  vague rules that survived extraction. */
export async function refineProfileContentWithLLM(
  preferences: ReadonlyArray<{ id: string; category: string; preference: string; confidence: number; pinned: boolean }>,
  deps: ExtractorDeps,
): Promise<{
  dropIds: Set<string>;
  mergeMap: Map<string, string>;  // sourceId → survivorId
  updated: Map<string, { preference: string; confidence: number }>;
}> {
  const dropIds = new Set<string>();
  const mergeMap = new Map<string, string>();
  const updated = new Map<string, { preference: string; confidence: number }>();

  if (preferences.length === 0) return { dropIds, mergeMap, updated };

  const config = deps.getConfig();
  // Only run refinement when there are enough preferences to warrant cleanup
  if (preferences.length < 3) return { dropIds, mergeMap, updated };

  const localConfig = deps.getLocalConfig?.();
  const modelId = deps.getModelId?.() ?? DEFAULT_MODEL_ID;

  try {
    const model = await buildConfiguredLanguageModel(
      modelId,
      deps.getKeys(),
      localConfig,
    );

    const { generateObject } = await import("ai");
    const { buildThinkingProviderOptions } = await import(
      "@/modules/ai/lib/thinking"
    );
    const thinkingOptions = buildThinkingProviderOptions(
      config.provider as ProviderId,
      "off", // refinement cleanup doesn't benefit from thinking
      modelId,
    );

    const input = preferences
      .map(
        (p) =>
          `[ID: ${p.id}] [${p.category}]${p.pinned ? " [pinned]" : ""} "${p.preference}" (confidence: ${p.confidence.toFixed(2)})`,
      )
      .join("\n");

    const { object } = await generateObject({
      model,
      system: PROFILE_REFINEMENT_SYSTEM,
      prompt: `Review this engineering profile for semantic duplicates, non-English text, and vague rules. Output only the corrections needed.\n\n${input}`,
      schema: profileRefinementSchema,
      ...(Object.keys(thinkingOptions).length > 0
        ? { providerOptions: thinkingOptions }
        : {}),
    });

    for (const action of object.actions) {
      switch (action.action) {
        case "drop": {
          dropIds.add(action.targetId);
          break;
        }
        case "merge": {
          if (action.mergedSourceIds && action.mergedSourceIds.length > 0) {
            for (const sourceId of action.mergedSourceIds) {
              if (sourceId !== action.targetId) {
                mergeMap.set(sourceId, action.targetId);
              }
            }
          }
          if (action.preference) {
            updated.set(action.targetId, {
              preference: action.preference,
              confidence: action.confidence ?? 0.5,
            });
          }
          break;
        }
        case "strengthen":
        case "translate": {
          if (action.preference) {
            updated.set(action.targetId, {
              preference: action.preference,
              confidence: action.confidence ?? 0.5,
            });
          }
          break;
        }
        case "keep":
        default:
          break;
      }
    }
  } catch (err) {
    console.warn(
      "[engineering-profile] Profile refinement LLM call failed:",
      err,
    );
    // Non-fatal — the unrefined profile is still valid.
  }

  return { dropIds, mergeMap, updated };
}

export { supportsProvider };
export type { Signal };
