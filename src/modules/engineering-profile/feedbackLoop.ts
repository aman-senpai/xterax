/**
 * The self-aware RL feedback loop.
 *
 * This describes a "Reflective Context Engineering
 * feedback loop" where the profile is not a passive log but an active
 * reward function: the agent's responses are scored against the
 * profile, and the score feeds back into the profile's confidence
 * weights.
 *
 * Concretely:
 *   1. After each agent turn, `scoreAlignment(turn, profile)` walks the
 *      assistant's tool calls and message text, and for each
 *      high-confidence preference in the profile, computes whether the
 *      agent's response honors or violates it.
 *   2. Violations emit a `rejected-change` signal that the refinement
 *      workflow turns into a downward confidence adjustment.
 *   3. Alignments, when the user accepts the turn (no rejection within
 *      the window), emit an `accepted-change` signal that bumps the
 *      preference's confidence.
 *   4. Over time the profile becomes a tighter, more accurate
 *      description of what the user actually wants — because it has
 *      been shaped by the same agent that consumes it.
 *
 * The KL anchor in the RLHF objective corresponds to: we never drop a
 * preference below `minConfidence`, and we never raise it above 0.99
 * without a minimum of `reinforcementMinSignals` independent
 * reinforcement signals. This prevents both catastrophic forgetting
 * and over-fitting to a single repeated observation.
 */

import { recordRejectedChange, recordAcceptedChange } from "./signals";
import { normalizeText } from "./confidence";
import type {
  Domain,
  Preference,
  Profile,
  Signal,
  SignalSource,
} from "./types";

import {
  REWARD_ANCHOR_MAX,
  REWARD_ANCHOR_MIN,
  REINFORCEMENT_MIN_SIGNALS,
} from "./confidence";
const ALIGNMENT_CONFIDENCE_THRESHOLD = 0.5;

export type TurnSnapshot = {
  sessionId: string;
  projectRoot: string | null;
  text: string;
  toolCalls: TurnToolCall[];
  timestamp: number;
};

export type TurnToolCall = {
  toolName: string;
  input: Record<string, unknown>;
};

export type AlignmentScore = {
  preferenceId: string;
  category: Domain;
  preference: string;
  alignment: "honored" | "violated" | "neutral";
  reason: string;
  weight: number;
};

/**
 * Scores a turn against the active profile. Walks every high-confidence
 * preference and classifies it as honored, violated, or neutral
 * relative to the agent's actual output.
 *
 * The classification is heuristic — we don't run an LLM here. The
 * intent is fast, deterministic, and good enough to drive a feedback
 * signal. The full LLM-based alignment check is the next iteration.
 */
export function scoreAlignment(
  turn: TurnSnapshot,
  profile: Profile,
): AlignmentScore[] {
  const scores: AlignmentScore[] = [];
  const text = (turn.text ?? "").toLowerCase();
  const textNorm = normalizeText(turn.text ?? "");
  for (const pref of profile.preferences) {
    if (pref.confidence < ALIGNMENT_CONFIDENCE_THRESHOLD) continue;
    if (pref.pinned) continue;
    const verdict = classifyAlignment(pref, turn, text, textNorm);
    if (verdict === "neutral") continue;
    scores.push({
      preferenceId: pref.id,
      category: pref.category,
      preference: pref.preference,
      alignment: verdict,
      reason: reasonFor(verdict, pref, turn),
      weight: pref.confidence,
    });
  }
  return scores;
}

function classifyAlignment(
  pref: Preference,
  turn: TurnSnapshot,
  text: string,
  textNorm: string,
): "honored" | "violated" | "neutral" {
  const prefNorm = normalizeText(pref.preference);
  const negative = isNegativePref(prefNorm);
  const keyword = keywordFor(prefNorm);
  if (!keyword) return "neutral";
  const present = keywordPresent(keyword, turn, text, textNorm);
  if (negative) {
    return present ? "violated" : "honored";
  }
  return present ? "honored" : "neutral";
}

const NEGATIVE_MARKERS = [/\b(don'?t|do not|never|stop|avoid|don\u2019t)\b/i];

function isNegativePref(prefNorm: string): boolean {
  return NEGATIVE_MARKERS.some((re) => re.test(prefNorm));
}

/**
 * Extracts a short, searchable keyword for the preference. Looks for
 * language-specific tokens first (TypeScript, Vitest, server
 * components, ...). Falls back to a single token.
 */
function keywordFor(prefNorm: string): string | null {
  const candidates = [
    "typescript",
    "javascript",
    "python",
    "rust",
    "go",
    "swift",
    "elixir",
    "phoenix",
    "server components",
    "client components",
    "redux",
    "vitest",
    "jest",
    "playwright",
    "tailwind",
    "feature-based",
    "monorepo",
    "hexagonal",
    "ddd",
    "cqrs",
    "postgres",
    "postgresql",
    "mysql",
    "sqlite",
    "redis",
    "graphql",
    "grpc",
    "rest",
    "docker",
    "kubernetes",
    "comments",
    "feature flags",
    "prettier",
    "eslint",
    "biome",
  ];
  for (const c of candidates) {
    if (prefNorm.includes(c)) return c;
  }
  const m = prefNorm.match(/\b([a-z][a-z0-9.+#-]{2,})\b/);
  return m?.[1] ?? null;
}

function keywordPresent(
  keyword: string,
  turn: TurnSnapshot,
  _text: string,
  textNorm: string,
): boolean {
  if (textNorm.includes(keyword)) return true;
  for (const tc of turn.toolCalls) {
    const blob = JSON.stringify(tc.input).toLowerCase();
    if (blob.includes(keyword)) return true;
  }
  return false;
}

function reasonFor(
  v: "honored" | "violated",
  pref: Preference,
  _turn: TurnSnapshot,
): string {
  return v === "violated"
    ? `Agent's response touched the discouraged: "${pref.preference}"`
    : `Agent's response honored: "${pref.preference}"`;
}

/**
 * Emits signals from an alignment score. Called by the learning agent
 * after each turn. Honors the KL anchor: never lowers a preference
 * below the reward anchor minimum via the signal weight; never
 * raises a preference above the max via a single signal.
 */
export async function emitAlignmentSignals(
  scores: AlignmentScore[],
  projectRoot: string | null,
  sessionId: string,
): Promise<Signal[]> {
  const out: Signal[] = [];
  for (const score of scores) {
    const evidencePrefix = `[${sessionId.slice(0, 8)}] `;
    if (score.alignment === "violated") {
      const signal = await recordRejectedChange(
        score.preference,
        `${evidencePrefix}${score.reason}`,
        {
          category: score.category,
          projectRoot,
        },
      );
      if (signal.accepted) out.push(signal.signal);
    } else if (score.alignment === "honored") {
      const signal = await recordAcceptedChange(
        score.preference,
        score.reason,
        {
          category: score.category,
          projectRoot,
        },
      );
      if (signal.accepted) out.push(signal.signal);
    }
  }
  return out;
}

/**
 * Records the user "accepting" a turn — the turn completed without a
 * follow-up rejection, the user moved on, or the user said
 * "thanks/ok". The autonomous learning agent calls this when it
 * detects a non-rejection window.
 */
export async function recordTurnAcceptance(
  projectRoot: string | null,
  sessionId: string,
  profile: Profile,
): Promise<Signal[]> {
  if (profile.preferences.length === 0) return [];
  // Only reinforce prefs that are not yet very strong (high evidence means the
  // preference is already locked in; spamming more "accepted-change" signals with
  // the exact same text just bloats the log and makes LLM consolidation harder).
  // Also limit to top 2 to reduce flood when many near-dups exist.
  const top = profile.preferences
    .filter((p) => p.confidence >= 0.7 && !p.pinned && (p.evidenceCount ?? 0) < 50)
    .slice(0, 2);
  const out: Signal[] = [];
  for (const pref of top) {
    const out2 = await recordAcceptedChange(
      pref.preference,
      `Turn accepted in session ${sessionId.slice(0, 8)}`,
      { category: pref.category, projectRoot },
    );
    if (out2.accepted) out.push(out2.signal);
  }
  return out;
}

export const FEEDBACK_LOOP_INTERNALS = {
  REWARD_ANCHOR_MIN,
  REWARD_ANCHOR_MAX,
  REINFORCEMENT_MIN_SIGNALS,
  ALIGNMENT_CONFIDENCE_THRESHOLD,
};

export type { SignalSource };
