/**
 * Structural noise filters for engineering-profile signals and preferences.
 * Semantic deduplication (e.g. "clean" vs "clear" code) is handled by the
 * refinement LLM; these guards only drop non-preference artifacts.
 */

const NOISE_PREFERENCE_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^(ok|okay|sure|thanks|thx|ty|got it|done|nice|lgtm|yep|yeah|no|nope|k)\s*\.?$/i,
  /^please (do|run|execute|try)/i,
  /^(can you|could you|would you|will you)/i,
  /^User edited\s+/i,
];

/** True when text is a synthetic fs-watcher message, not user-authored chat. */
export function isSyntheticObservationMessage(text: string): boolean {
  return /^User edited\s+.+\s*:\s*/i.test(text.trim());
}

/** True when a preference string should never enter the profile. */
export function isNoisePreference(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return true;
  return NOISE_PREFERENCE_PATTERNS.some((re) => re.test(t));
}

/** True when a path refers to the engineering-profile mirror (.xterax). */
export function isXteraxProfilePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return (
    norm.endsWith("/.xterax/profile.md") ||
    norm.endsWith("/.xterax") ||
    /\/\.xterax(\/|$)/.test(norm)
  );
}