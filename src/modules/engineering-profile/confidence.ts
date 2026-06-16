import type { RefinementConfig, Signal, SignalSource } from "./types";
import { SOURCE_WEIGHTS } from "./types";

/**
 * Squashes a real-valued score to [0, 1]. A sum of weighted signals is
 * bounded near ±1 once enough evidence accumulates, which is what we want
 * for "do we believe this".
 */
export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Combines the time-decayed weight of observed signals into a real-valued
 * score, then squashes it. A signal at t = 0 contributes `weight` to the sum;
 * an old signal contributes less because the user's preferences can drift.
 */
export function aggregateScore(
  signals: ReadonlyArray<Signal>,
  now: number,
  config: RefinementConfig,
): number {
  if (signals.length === 0) return 0;
  const halfLife = Math.max(config.decayHalfLifeMs, 1);
  let sum = 0;
  for (const s of signals) {
    const age = Math.max(0, now - s.timestamp);
    const decay = 0.5 ** (age / halfLife);
    const w = SOURCE_WEIGHTS[s.source] * s.weight;
    sum += w * decay;
  }
  return logistic(sum);
}

export type SourceBreakdown = Partial<Record<SignalSource, number>>;

export function sourceBreakdown(
  signals: ReadonlyArray<Signal>,
): SourceBreakdown {
  const out: SourceBreakdown = {};
  for (const s of signals) {
    out[s.source] = (out[s.source] ?? 0) + 1;
  }
  return out;
}

export function totalWeight(signals: ReadonlyArray<Signal>): number {
  let total = 0;
  for (const s of signals) {
    total += SOURCE_WEIGHTS[s.source] * s.weight;
  }
  return total;
}

/**
 * Returns the unique source channels that produced evidence for the
 * preference. More distinct channels = more robust belief.
 */
export function distinctSourceCount(signals: ReadonlyArray<Signal>): number {
  const set = new Set<SignalSource>();
  for (const s of signals) set.add(s.source);
  return set.size;
}

/**
 * Bonuses a confidence score with extra weight when many independent
 * evidence channels reinforce it. Maps an "evidence strength" factor in
 * [0, +inf) to a multiplier in [0, 1] that gently pulls logistic outputs
 * toward more extreme values. Output is then re-clamped to [0, 1].
 */
export function adjustByEvidence(
  base: number,
  signals: ReadonlyArray<Signal>,
): number {
  const channels = distinctSourceCount(signals);
  const evidenceCount = signals.length;
  if (channels === 0 && evidenceCount === 0) return base;
  const channelFactor = Math.min(1, channels / 3);
  const countFactor = Math.min(1, evidenceCount / 5);
  const strength = 1 + channelFactor * 0.3 + countFactor * 0.2;
  const centered = (base - 0.5) * 2;
  const stretched = Math.tanh(centered * strength);
  return clamp01(0.5 + stretched / 2);
}

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

export function normalizeConfidence(
  score: number,
  signals: ReadonlyArray<Signal>,
): number {
  const adj = adjustByEvidence(score, signals);
  return clamp01(adj);
}

export function olderSignal(a: Signal, b: Signal): Signal {
  return a.timestamp <= b.timestamp ? a : b;
}

/**
 * Stable preference key (category + normalized text). Used to merge
 * duplicates: same key, same scope, same project = same preference.
 */
export function preferenceKey(category: string, text: string): string {
  return `${category}::${normalizeText(text)}`;
}

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Levenshtein-based similarity for fuzzy de-duplication of preferences.
 * Returns a value in [0, 1]. Used to detect near-duplicates across
 * "use TypeScript" and "prefer TypeScript" style phrasings.
 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  const max = Math.max(na.length, nb.length);
  return 1 - dist / max;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}
