/**
 * Pattern mining.
 *
 * Periodically sweeps recent chat history and tool-call patterns to
 * discover unspoken preferences the user has never stated. These are
 * the "micro-decisions you'd never document" that the profile
 * system aims to capture — they live in the structure of how the user
 * works, not in their stated words.
 *
 * The miner reads the last N chat turns and recent tool-call records
 * (e.g. what file extensions the user typically edits, what kinds of
 * tools they reach for first, what time-of-day patterns emerge,
 * etc.). It then runs the LLM to extract latent preferences.
 *
 * Discovered patterns become signals. They go through the same
 * refinement pipeline as any other signal. The user can pin or
 * rollback anything the miner surfaces.
 */

import { z } from "zod";
import { buildConfiguredLanguageModel } from "@/modules/ai/lib/agent";
import { DEFAULT_MODEL_ID } from "@/modules/ai/config";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { recordSignal } from "./signals";
import { storage } from "./storage";
import { preferenceKey } from "./confidence";
import type { Domain, Signal, SignalSource } from "./types";
import { isKnownDomainHint } from "./types";

const PATTERN_MINER_SYSTEM = `You are a pattern-mining agent. You observe a user's coding workflow over a window of recent activity and surface unspoken preferences — the "micro-decisions" they make but never state.

You are NOT looking for explicit statements. You are looking for STRUCTURAL patterns:
- The user always opens the terminal pane first when starting work (workflow signal)
- The user always includes a CHANGELOG entry alongside API changes (documentation signal)
- The user prefers smaller commits (workflow signal)
- The user works primarily in /src/<domain>/ folders (architecture signal)
- The user always asks for tests after the first implementation pass (testing signal)

For each pattern, return:
- category: a short lowercase label
- preference: a concise declarative statement of the inferred preference
- evidence: a 1-line summary of the pattern observed
- weight: 0.1 to 0.7 (lower than explicit feedback; these are inferences, not statements)

Return empty list if no clear pattern is observable. Be conservative — false positives pollute the profile.`;

const patternSchema = z.object({
  patterns: z.array(
    z.object({
      category: z.string().min(1).max(40),
      preference: z.string().min(8).max(240),
      evidence: z.string().min(1),
      weight: z.number().min(0.1).max(0.7),
    }),
  ),
});

export type PatternMinerOptions = {
  projectRoot: string | null;
  maxTurns?: number;
  lookbackMs?: number;
};

export type PatternMinerResult = {
  patterns: {
    category: Domain;
    preference: string;
    evidence: string;
    weight: number;
  }[];
  recorded: Signal[];
  discarded: { text: string; reason: string }[];
};

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export async function minePatterns(
  options: PatternMinerOptions,
): Promise<PatternMinerResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const result: PatternMinerResult = {
    patterns: [],
    recorded: [],
    discarded: [],
  };
  if (!options.projectRoot) return result;
  const signals = await storage.loadSignals("user", null);
  if (signals.length === 0) return result;
  const since = Date.now() - lookbackMs;
  const recent = signals.filter((s) => s.timestamp >= since).slice(-maxTurns);
  if (recent.length < 5) return result;
  const chat = useChatStore.getState();
  const prompt = renderSignalsForMiner(recent);
  try {
    const { generateObject } = await import("ai");
    const model = await buildConfiguredLanguageModel(
      chat.selectedModelId ?? DEFAULT_MODEL_ID,
      chat.apiKeys as ProviderKeys,
    );
    const { object } = await generateObject({
      model,
      system: PATTERN_MINER_SYSTEM,
      prompt,
      schema: patternSchema,
    });
    for (const p of object.patterns) {
      const category = isKnownDomainHint(p.category)
        ? (p.category as Domain)
        : ("general" as Domain);
      const key = preferenceKey(category, p.preference);
      const alreadyKnown = recent.some(
        (s) => preferenceKey(s.category, s.preference) === key,
      );
      if (alreadyKnown) {
        result.discarded.push({ text: p.preference, reason: "duplicate" });
        continue;
      }
      const recorded = await recordSignal({
        source: "recurring-request" as SignalSource,
        category,
        preference: p.preference,
        evidence: `[pattern-miner] ${p.evidence}`,
        weight: Math.min(0.7, Math.max(0.1, p.weight)),
        scope: "user",
        projectRoot: options.projectRoot,
      });
      if (recorded.accepted) {
        result.patterns.push({
          category,
          preference: p.preference,
          evidence: p.evidence,
          weight: p.weight,
        });
        result.recorded.push(recorded.signal);
      }
    }
  } catch (err) {
    console.warn("[engineering-profile] pattern miner failed:", err);
    result.discarded.push({
      text: "miner",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return result;
}

function renderSignalsForMiner(signals: ReadonlyArray<Signal>): string {
  const lines: string[] = [];
  for (const s of signals) {
    lines.push(
      `[${new Date(s.timestamp).toISOString().slice(0, 10)}] (${s.source}, ${s.category}) ${s.preference}`,
    );
  }
  return lines.join("\n");
}

export const PATTERN_MINER_INTERNALS = {
  DEFAULT_MAX_TURNS,
  DEFAULT_LOOKBACK_MS,
};
