import {
  recordExplicitFeedback,
  recordRecurringRequest,
  recordRejectedChange,
  recordUserModification,
} from "./signals";
import { storage } from "./storage";
import { preferenceKey, normalizeText } from "./confidence";
import type { Domain, Signal } from "./types";
import { z } from "zod";
import { isDomain } from "./types";
import { DEFAULT_MODEL_ID, type ProviderId } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveProfileModelSelection } from "./profileModel";
import { isSyntheticObservationMessage } from "./signalNoise";

const RECURRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RECURRING_THRESHOLD = 3;
/** Identical message sent this many times records a preference even if LLM declines each time. */
const MESSAGE_REPEAT_THRESHOLD = 3;

const observedFingerprints = new Set<string>();
const messageRepeatCounts = new Map<string, number>();

export type ObservationInput = {
  text: string;
  projectRoot: string | null;
  timestamp?: number;
  /** Bypass the per-message fingerprint cache (tests only). */
  force?: boolean;
};

export type ObservationResult = {
  recorded: Signal[];
  skipped: string[];
};

/**
 * Passively observes a user message and records signals for stable
 * preferences/feedback via LLM intent classification (same model/thinking
 * config as profile refinement). No regex heuristics.
 */
export async function observeUserMessage(
  input: ObservationInput,
): Promise<ObservationResult> {
  const text = (input.text ?? "").trim();
  if (!text) return { recorded: [], skipped: [] };
  if (isSyntheticObservationMessage(text)) {
    return { recorded: [], skipped: ["synthetic-edit"] };
  }

  if (input.projectRoot) {
    try {
      const { ensureBootstrap } = await import("./bootstrap");
      await ensureBootstrap(input.projectRoot);
    } catch {
      /* non-fatal */
    }
  }

  const recorded: Signal[] = [];
  const skipped: string[] = [];

  const fingerprint = observationFingerprint(input.projectRoot, text);
  if (!input.force && observedFingerprints.has(fingerprint)) {
    // The message was already classified as a preference on a previous turn.
    // Don't re-run the LLM, but still feed the recurring-request counter so
    // repeated identical messages build confidence over time.
    const recurring = await tryRecordRecurring(
      text,
      input.projectRoot,
      input.timestamp,
      recorded,
      true,
    );
    if (!recurring) skipped.push("already-observed");
    return { recorded, skipped };
  }

  const intent = await classifyIntentWithLLM(text, input.projectRoot);

  if (intent === null) {
    skipped.push("llm-unavailable");
    const recurring = await tryRecordRecurring(
      text,
      input.projectRoot,
      input.timestamp,
      recorded,
    );
    if (!recurring) skipped.push("no-preference");
    return { recorded, skipped };
  }

  if (intent.hasStablePreference && intent.preference) {
    // Only cache the fingerprint when we actually record a signal —
    // "no preference" results are re-evaluated on future turns so a
    // misclassification on turn 1 doesn't permanently block detection.
    observedFingerprints.add(fingerprint);
    clearRepeatCounter(input.projectRoot, text);
    let pref = cleanSentence(intent.preference);
    const cat = intent.category ?? "general";
    const ev = intent.evidence || text.slice(0, 240);
    const result = intent.isRejection
      ? await recordRejectedChange(pref, ev, {
          category: cat,
          projectRoot: input.projectRoot,
        })
      : await recordExplicitFeedback(pref, ev, {
          category: cat,
          projectRoot: input.projectRoot,
        });
    if (result.accepted) {
      recorded.push(result.signal);
    } else if (result.reason) {
      skipped.push(result.reason);
    }
    return { recorded, skipped };
  }

  const recurring = await tryRecordRecurring(
    text,
    input.projectRoot,
    input.timestamp,
    recorded,
  );
  if (!recurring) skipped.push("no-preference");
  return { recorded, skipped };
}

function observationFingerprint(
  projectRoot: string | null,
  text: string,
): string {
  return `${projectRoot ?? "global"}::${normalizeText(text)}`;
}

function repeatKey(projectRoot: string | null, text: string): string {
  return `${projectRoot ?? "global"}::${normalizeText(text)}`;
}

function clearRepeatCounter(
  projectRoot: string | null,
  text: string,
): void {
  messageRepeatCounts.delete(repeatKey(projectRoot, text));
}

function bumpRepeatCounter(projectRoot: string | null, text: string): number {
  const key = repeatKey(projectRoot, text);
  const next = (messageRepeatCounts.get(key) ?? 0) + 1;
  messageRepeatCounts.set(key, next);
  return next;
}

async function tryRecordRecurring(
  text: string,
  projectRoot: string | null,
  timestamp: number | undefined,
  recorded: Signal[],
  alreadyClassified = false,
): Promise<boolean> {
  // Raw repeat recording bypasses LLM translation and creates duplicates
  // (e.g. Hindi in general + English in code-quality). Only use when the
  // LLM never classified this fingerprint.
  if (!alreadyClassified) {
    const repeats = bumpRepeatCounter(projectRoot, text);
    if (repeats >= MESSAGE_REPEAT_THRESHOLD) {
      const pref = cleanSentence(text).slice(0, 240);
      const result = await recordRecurringRequest(pref, text.slice(0, 240), {
        category: "general",
        projectRoot,
        weight: 0.65,
      });
      if (result.accepted) {
        recorded.push(result.signal);
        return true;
      }
    }
  }

  const recurring = await detectRecurring(text, projectRoot, timestamp);
  if (!recurring) return false;
  const result = await recordRecurringRequest(recurring, text.slice(0, 240), {
    category: "general",
    projectRoot,
    weight: 0.6,
  });
  if (result.accepted) recorded.push(result.signal);
  return result.accepted;
}

function cleanSentence(s: string): string {
  let out = s.trim();
  out = out.replace(/^[,.;:\-–—\s]+/, "").replace(/[,.;:\-–—\s]+$/, "");
  if (out.length > 0) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

async function detectRecurring(
  text: string,
  projectRoot: string | null,
  timestamp: number = Date.now(),
): Promise<string | null> {
  const norm = normalizeText(text);
  if (norm.length < 8) return null;
  const signals = await storage.loadSignals("user", projectRoot);
  const since = (timestamp ?? Date.now()) - RECURRING_WINDOW_MS;
  let count = 0;
  for (const s of signals) {
    if (s.timestamp < since) continue;
    const sn = normalizeText(s.preference);
    if (sn === norm) count++;
  }
  if (count + 1 >= RECURRING_THRESHOLD) {
    return text.slice(0, 240);
  }
  return null;
}

const intentSchema = z.object({
  hasStablePreference: z.boolean(),
  preference: z.string().max(280).optional(),
  category: z.string().optional(),
  isRejection: z.boolean().optional(),
  evidence: z.string().optional(),
});

async function classifyIntentWithLLM(
  text: string,
  projectRoot: string | null,
): Promise<{
  hasStablePreference: boolean;
  preference: string | null;
  category: Domain | null;
  isRejection: boolean;
  evidence: string;
} | null> {
  try {
    const { makeExtractorDeps } = await import("./autoRefine");
    const deps = makeExtractorDeps();
    const config = deps.getConfig();
    const localConfig = deps.getLocalConfig?.();
    const keys = deps.getKeys();
    const modelId = deps.getModelId?.() ?? DEFAULT_MODEL_ID;
    const { buildConfiguredLanguageModel } = await import(
      "@/modules/ai/lib/agent"
    );
    const model = await buildConfiguredLanguageModel(modelId, keys, localConfig);

    const prefs = usePreferencesStore.getState();
    const chat = useChatStore.getState();
    const selection = resolveProfileModelSelection({
      profileProvider: prefs.profileProvider,
      profileModelId: prefs.profileModelId ?? "",
      selectedModelId: chat.selectedModelId,
      defaultModelId: prefs.defaultModelId,
      customEndpoints: prefs.customEndpoints,
      apiKeys: keys,
    });
    console.log(
      `[engineering-profile] intent model: provider=${selection.provider} model=${selection.registryModelId} source=${selection.source}`,
    );

    const { generateObject } = await import("ai");
    const { buildThinkingProviderOptions } = await import(
      "@/modules/ai/lib/thinking"
    );
    const thinkingOptions = buildThinkingProviderOptions(
      config.provider as ProviderId,
      config.thinkingLevel ?? "off",
      modelId,
    );

    const sys = `You detect stable, reusable engineering preferences in user messages. Your job is DETECTION only — faithfully record what the user expressed. The quality gate (distilling vague statements into precise rules) happens in a separate step.

The user may write in ANY language (English, Hindi, Urdu, Spanish, etc.). Infer intent from meaning.

## What IS a stable preference

Any enduring guidance the agent should remember across sessions. Err on the side of detection:
- "Mujhe clean code pasand hai" → preference (code-quality, "I prefer clean code")
- "I like clean code" → preference (code-quality, "I prefer clean code")
- "Always use TypeScript" → preference (frontend, "Always use TypeScript")
- "Don't use multi_edit for single-line changes" → preference + rejection (tool-usage)
- "I like flirty comments" → preference (tone, "I like flirty comments")
- "No unnecessary comments, small functions, DRY" → preference (code-quality)

Even vague preferences like "I prefer clean code" or "Make it fast" should be recorded as-is. The refinement step handles making them specific.

## What is NOT a stable preference

These are one-off, not enduring:
- Task requests: "fix this bug", "refactor this file", "run the tests"
- Clarifications answering the agent's questions
- Chit-chat: thanks, greetings, jokes, OK
- Questions: "what do I like?", "can you help with X?"

## Category

Use descriptive, domain-specific names — not just "general":
- "code-quality", "tone", "tool-usage", "testing", "frontend", "backend"
- "swift", "react", "database", "api-design", "devops", "debugging", "ux"
- Only use "general" if nothing more specific fits.

## Preference text — CRITICAL: MUST BE ENGLISH

The profile.md is read by coding agents that work in English. You MUST output English regardless of input language. Never output Hindi, Hinglish, Urdu, Spanish, or any other language — even if written in Latin/Roman script.

Translate Hinglish (Hindi in Latin script) to English:
- User: "Mujhe clean code pasand hai" → preference: "I prefer clean code"
- User: "Mujhe flirty comments pasand hain" → preference: "I like flirty comments"
- User: "Hamesha TypeScript use karo" → preference: "Always use TypeScript"
- User: "Yeh mat karo" → preference: "Avoid this approach"
- User: "Mujhe X pasand hai" → preference: "I prefer X"

This is a hard requirement. The preference field will be injected into an English-language coding agent's context. Non-English text in the profile degrades the agent's behavior. Translate every input to English.

## Rejections

When the user says "don't do X", set isRejection: true. State what they want to avoid AND what they want instead if that's clear from context.`;

    const { object } = await generateObject({
      model,
      system: sys,
      prompt: `User message:\n"""\n${text}\n"""\n\n(workspace: ${projectRoot ?? "global"})`,
      schema: intentSchema,
      ...(Object.keys(thinkingOptions).length > 0
        ? { providerOptions: thinkingOptions }
        : {}),
    });

    if (!object.hasStablePreference || !object.preference) {
      return {
        hasStablePreference: false,
        preference: null,
        category: null,
        isRejection: false,
        evidence: "",
      };
    }
    const cat: Domain =
      object.category && isDomain(object.category) ? object.category : "general";
    return {
      hasStablePreference: true,
      preference: object.preference.trim(),
      category: cat,
      isRejection: !!object.isRejection,
      evidence: (object.evidence || text).trim().slice(0, 240),
    };
  } catch (err) {
    console.warn(
      "[engineering-profile] LLM intent classification via generateObject failed — falling back to generateText:",
      (err as Error)?.message ?? err,
    );
    return await classifyIntentWithTextFallback(text, projectRoot);
  }
}

async function classifyIntentWithTextFallback(
  text: string,
  projectRoot: string | null,
): Promise<{
  hasStablePreference: boolean;
  preference: string | null;
  category: Domain | null;
  isRejection: boolean;
  evidence: string;
} | null> {
  try {
    const { makeExtractorDeps } = await import("./autoRefine");
    const deps = makeExtractorDeps();
    const config = deps.getConfig();
    const localConfig = deps.getLocalConfig?.();
    const keys = deps.getKeys();
    const modelId = deps.getModelId?.() ?? DEFAULT_MODEL_ID;
    const { buildConfiguredLanguageModel } = await import(
      "@/modules/ai/lib/agent"
    );
    const model = await buildConfiguredLanguageModel(modelId, keys, localConfig);

    const { buildThinkingProviderOptions } = await import(
      "@/modules/ai/lib/thinking"
    );
    const thinkingOptions = buildThinkingProviderOptions(
      config.provider as ProviderId,
      config.thinkingLevel ?? "off",
      modelId,
    );

    const { generateText } = await import("ai");

    const prompt = `Detect if this message expresses a stable, reusable engineering preference (not a one-off task instruction). Err on the side of detection. Output raw JSON on one line, no markdown.

CRITICAL: Output the "preference" field in ENGLISH, even if the user wrote in Hindi, Urdu, Spanish, etc. Translate to English.

Message: """${text}"""
Workspace: ${projectRoot ?? "global"}

IS a preference (translate to English):
- "Mujhe clean code pasand hai" → preference: "I prefer clean code"
- "Mujhe flirty comments pasand hain" → preference: "I like flirty comments"
- "Hamesha TypeScript use karo" → preference: "Always use TypeScript"
- "I like clean code" → preference: "I prefer clean code"
- "Don't use Redux" → true, isRejection: true

NOT a preference:
- "fix this bug", "thanks", "what does this do?" → false

Categories: code-quality, tone, tool-usage, testing, frontend, backend, swift, react, database, api-design, devops, debugging, ux, general.

Output EXACTLY: {"hasStablePreference":true,"preference":"I prefer clean code","category":"code-quality","isRejection":false,"evidence":"User said they like clean code"}`;

    const { text: responseText } = await generateText({
      model,
      prompt,
      temperature: 0,
      ...(Object.keys(thinkingOptions).length > 0
        ? { providerOptions: thinkingOptions }
        : {}),
    });

    // Extract JSON from the response — try to handle models that wrap in fences
    let json = responseText.trim();
    const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) json = fenceMatch[1].trim();
    // Also handle models that prefix with explanatory text
    const braceIdx = json.indexOf("{");
    if (braceIdx > 0) json = json.slice(braceIdx);
    const lastBrace = json.lastIndexOf("}");
    if (lastBrace >= 0 && lastBrace < json.length - 1) {
      json = json.slice(0, lastBrace + 1);
    }

    const parsed = JSON.parse(json);
    const hasStablePreference = !!parsed.hasStablePreference;
    const cat: Domain =
      parsed.category && isDomain(parsed.category)
        ? parsed.category
        : "general";
    const preference = hasStablePreference
      ? String(parsed.preference ?? "").trim().slice(0, 280)
      : null;
    const evidence = String(parsed.evidence ?? text).trim().slice(0, 240);

    return {
      hasStablePreference,
      preference,
      category: cat,
      isRejection: !!parsed.isRejection,
      evidence,
    };
  } catch (err) {
    console.warn(
      "[engineering-profile] generateText fallback also failed:",
      (err as Error)?.message ?? err,
    );
    return null;
  }
}

/** Clears in-memory observation caches (tests only). */
export function resetObservationStateForTests(): void {
  observedFingerprints.clear();
  messageRepeatCounts.clear();
}

export { preferenceKey, recordUserModification };