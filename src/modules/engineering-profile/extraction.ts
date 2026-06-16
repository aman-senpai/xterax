import { z } from "zod";
import { buildConfiguredLanguageModel, type LocalProviderConfig } from "@/modules/ai/lib/agent";
import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import type { ProviderKeys, CustomEndpointKeys } from "@/modules/ai/lib/keyring";
import {
  isDomain,
  DOMAIN_HINTS,
  type Domain,
  type ExtractionResult,
  type PreferenceCandidate,
  type RefinementConfig,
  type RefinementProvider,
  type Signal,
} from "./types";
import { normalizeText, preferenceKey, similarity } from "./confidence";
import { SOURCE_WEIGHTS } from "./types";

export type ExtractorDeps = {
  getKeys: () => ProviderKeys;
  getModelId?: () => string;
  getLocalConfig?: () => LocalProviderConfig | undefined;
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  getConfig: () => RefinementConfig;
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
});

const extractionSchema = z.object({
  candidates: z.array(candidateSchema),
});

const EXTRACTION_SYSTEM = `You extract stable engineering, architecture, design, and workflow preferences from observed user signals.

A "stable preference" is a long-term tendency, not a one-off request. Examples: "prefer TypeScript", "use feature-based folders", "keep code concise", "avoid Redux", "prefer server components". One-shot task instructions are NOT preferences and must be discarded.

For each candidate, return:
- category: a short lowercase label (e.g. ${DOMAIN_HINTS.slice(0, 4).join(", ")}, ...). The system accepts any category string; do not restrict yourself to a fixed list.
- preference: a concise, declarative sentence (no leading "User")
- evidence: a 1-line quote or summary of the supporting signal
- weight: 0.1 to 2.0, higher = stronger signal

If the input contains only one-off task instructions, return an empty list. Do not invent preferences.`;

export const llmExtractor: Extractor = async (signals, deps) => {
  const config = deps.getConfig();
  if (signals.length === 0) {
    return { candidates: [], discarded: [], provider: config.provider };
  }
  if (config.provider === "heuristic") {
    return heuristicExtractor(signals, deps);
  }
  const localConfig = deps.getLocalConfig?.();
  const model = await buildConfiguredLanguageModel(
    deps.getModelId?.() ?? DEFAULT_MODEL_ID,
    deps.getKeys(),
    localConfig,
  );
  const prompt = renderSignalsForLLM(signals);
  try {
    const { generateObject } = await import("ai");
    const { object } = await generateObject({
      model,
      system: EXTRACTION_SYSTEM,
      prompt,
      schema: extractionSchema,
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
      });
    }
    return { candidates, discarded, provider: config.provider };
  } catch (err) {
    console.warn(
      "[engineering-profile] LLM extraction failed, falling back to heuristic:",
      err,
    );
    return heuristicExtractor(signals, deps);
  }
};

export const heuristicExtractor: Extractor = async (signals) => {
  const seen = new Map<string, PreferenceCandidate>();
  const discarded: { text: string; reason: string }[] = [];
  for (const s of signals) {
    if (looksLikeOneOff(s)) {
      discarded.push({ text: s.preference, reason: "one-off" });
      continue;
    }
    const key = preferenceKey(s.category, s.preference);
    const prior = seen.get(key);
    if (prior) {
      prior.weight = Math.min(2, prior.weight + 0.2);
    } else {
      seen.set(key, {
        category: s.category,
        preference: s.preference,
        evidence: s.evidence || s.preference,
        weight: clampWeight(SOURCE_WEIGHTS[s.source] * s.weight),
      });
    }
  }
  for (const [k, v] of Array.from(seen.entries())) {
    for (const [k2, v2] of seen.entries()) {
      if (k === k2) continue;
      if (v.category !== v2.category) continue;
      if (similarity(v.preference, v2.preference) >= 0.85) {
        if (v2.weight > v.weight) {
          seen.delete(k);
          break;
        }
      }
    }
  }
  return { candidates: Array.from(seen.values()), discarded, provider: "heuristic" };
};

function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0.1) return 0.1;
  if (w > 2) return 2;
  return w;
}

function looksLikeOneOff(s: Signal): boolean {
  const t = normalizeText(s.preference);
  if (!t) return true;
  if (/^(fix|add|update|rename|delete|change|implement|refactor|clean up) /i.test(t)) {
    return true;
  }
  if (/\b(in this file|on this page|for this task|today|tmp|todo|hack)\b/i.test(t)) {
    return true;
  }
  if (s.source === "rejected-change" && Math.abs(s.weight) < 0.01) return true;
  return false;
}

function renderSignalsForLLM(signals: ReadonlyArray<Signal>): string {
  const lines: string[] = [];
  for (const s of signals) {
    lines.push(
      `[${new Date(s.timestamp).toISOString()}] (${s.source}, ${s.category}) ${s.preference} — ${s.evidence}`,
    );
  }
  return lines.join("\n");
}

export function pickExtractor(
  config: RefinementConfig,
): Extractor {
  if (config.provider === "heuristic") return heuristicExtractor;
  return llmExtractor;
}

export function supportsProvider(p: RefinementProvider): boolean {
  return (
    p === "heuristic" ||
    p === "openai" ||
    p === "anthropic" ||
    p === "google" ||
    p === "groq" ||
    p === "openrouter" ||
    p === "openai-compatible" ||
    p === "lmstudio" ||
    p === "mlx" ||
    p === "ollama"
  );
}

export type { Signal };
