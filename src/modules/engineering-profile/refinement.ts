import {
  normalizeText,
  // preferenceKey is used inside the exported buildFallbackCandidates helper (tested directly).
  preferenceKey,
} from "./confidence";
import { isNoisePreference } from "./signalNoise";
import {
  type Extractor,
  type ExtractorDeps,
  pickExtractor,
  refineProfileContentWithLLM,
} from "./extraction";
import { makeBlankProfile, newPreferenceId, storage } from "./storage";
import {
  DEFAULT_REFINEMENT_CONFIG,
  type Domain,
  type DomainProfile,
  normalizeDomain,
  type Preference,
  type PreferenceCandidate,
  type Profile,
  type ProfileSnapshot,
  type RefinementConfig,
  type Scope,
  type Signal,
  type SignalSource,
  type SnapshotChange,
} from "./types";

/** Weighted reinforcement per signal source. Measures evidence quality, not
 *  just volume. Profile edits are the strongest signal; repeated requests
 *  add marginal weight. */
export const REINFORCEMENT_WEIGHT: Record<SignalSource, number> = {
  "explicit-feedback": 1.0,
  "user-modification": 5.0, // direct edit to profile.md
  "rejected-change": 2.0,   // explicit correction
  "accepted-change": 1.0,
  "architecture-decision": 1.0,
  "design-critique": 1.0,
  "workflow-instruction": 1.0,
  "config-setting": 0.5,
  "recurring-request": 0.25, // low-weight, just repetition
};

function computeReinforcement(signals: ReadonlyArray<Signal>): number {
  let total = 0;
  for (const s of signals) {
    total += REINFORCEMENT_WEIGHT[s.source] ?? 0.5;
  }
  return Math.round(total * 100) / 100;
}

/** Stable identity for dedup across rephrasings. */
export function canonicalRuleId(category: string, preference: string): string {
  const slug = preference
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
  return `${normalizeDomain(category)}_${slug}`;
}

/** Caps self-scored LLM precision using simple structural heuristics.
 *  The LLM judges its own output — this provides a lightweight sanity check
 *  against overconfident vague statements. */
export function validatePrecision(pref: string, claimedPrecision: number): number {
  // Vague, non-actionable words suggest low precision regardless of LLM claim.
  const vagueWords = /\b(clean|good|better|best practice|proper|appropriate|scalable|robust|efficient|optimized?)\b/i;
  const vagueCount = (pref.match(vagueWords) ?? []).length;

  // Proper nouns: at least one capitalized technical term that isn't just
  // the first word of the sentence. Matches "Tailwind CSS", "SwiftUI",
  // "React Compiler", "NSMenu", etc.
  const properNounPattern = /[a-z]\s+[A-Z][a-zA-Z]+|[A-Z][a-z]+[A-Z][a-z]+|[A-Z]{2,}|[A-Z][a-z]+\s+[A-Z]/;
  const hasProperNoun = properNounPattern.test(pref);

  // Concrete terminology + action verbs suggest genuine precision.
  const concreteTerms = /\b(use|prefer|avoid|never|always|must|should)\b.{10,}(framework|api|pattern|method|function|component|hook|library|tool|command|flag|option|config|type|interface|class|module|service|endpoint|query|mutation|state|prop|attribute|directive|decorator|middleware|route|handler|controller|model|schema|migration|transaction|index|constraint|trigger|event|stream|pipe|buffer|timeout|retry|cache|batch|queue|worker|job|task|pipeline|workflow)\b/i;
  const hasConcrete = concreteTerms.test(pref) || hasProperNoun;

  // Structural quality signals
  const wordCount = pref.split(/\s+/).length;
  const hasAlternative = /\b(instead|rather than|avoid|prefer|over\b.*\buse\b)/i.test(pref);
  const hasCondition = /\b(when|if|unless|only if|except|during)\b/i.test(pref);

  let score = claimedPrecision;

  // Penalize vagueness
  if (vagueCount >= 3) score = Math.min(score, 0.4);
  else if (vagueCount >= 1) score = Math.min(score, 0.65);

  // Short statements without concrete terms or proper nouns are likely imprecise
  if (wordCount < 8 && !hasConcrete) score = Math.min(score, 0.5);
  else if (wordCount < 15 && !hasConcrete) score = Math.min(score, 0.6);

  // Structural bonuses
  if (hasConcrete) score = Math.min(score + 0.03, 0.98);
  if (hasAlternative) score = Math.min(score + 0.02, 0.98);
  if (hasCondition) score = Math.min(score + 0.02, 0.98);

  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

export type RefineOptions = {
  scope: Scope;
  projectRoot: string | null;
  now?: number;
  reason?: ProfileSnapshot["reason"];
  note?: string | null;
};

export type RefineResult = {
  profile: Profile;
  snapshot: ProfileSnapshot;
  removed: Preference[];
  added: Preference[];
  modified: Preference[];
  dropped: Preference[];
};

/**
 * Core refinement pass:
 *  1. Load all signals for the scope.
 *  2. Run LLM extraction to produce candidates.
 *  3. For each candidate, find or create a preference and re-score.
 *  4. Decay / demote / drop stale preferences.
 *  5. Resolve conflicts (project overrides user).
 *  6. Generate per-domain summaries.
 *  7. Snapshot, persist, return.
 */
export async function refineProfile(
  deps: ExtractorDeps,
  options: RefineOptions,
): Promise<RefineResult> {
  const now = options.now ?? Date.now();
  const config = deps.getConfig();
  let previous = await storage.getProfile(options.scope, options.projectRoot);
  const rawSignals = await storage.loadSignals(
    options.scope,
    options.projectRoot,
  );
  const signals = rawSignals.filter((s) => !isNoisePreference(s.preference));

  // Defensive filter: if this profile somehow accumulated preferences that are
  // obviously about a completely different project (historical resolution bugs),
  // drop them so they don't poison this project's taste forever.
  if (previous && options.projectRoot) {
    const root = options.projectRoot.toLowerCase();
    const isLikelyResumeProject =
      root.includes("resume") || root.includes("cv");
    previous = {
      ...previous,
      preferences: previous.preferences.filter((p) => {
        const t = p.preference.toLowerCase();
        const resumeSignal =
          t.includes("resume") ||
          t.includes("star format") ||
          t.includes("bullet point");
        if (resumeSignal && !isLikelyResumeProject) return false;
        return true;
      }),
    };
  }
  const extractor: Extractor = pickExtractor(config);

  let extraction: {
    candidates: PreferenceCandidate[];
    discarded?: unknown[];
    provider?: string;
  };
  try {
    extraction = await extractor(signals, {
      ...deps,
      getPriorPreferences: () => previous?.preferences ?? [],
      currentProjectRoot: options.projectRoot,
    });
  } catch (err) {
    console.warn(
      "[engineering-profile] LLM extraction failed:",
      (err as Error)?.message ?? err,
    );
    extraction = { candidates: [], discarded: [], provider: config?.provider };
  }

  // Consolidation is LLM-only. When extraction returns nothing, carry forward
  // existing priors (minus structural noise) rather than transcribing raw signals.

  const next = previous
    ? cloneProfile(previous, now)
    : makeBlankProfile(options.scope, options.projectRoot, now);

  // 1. Prior preferences - all deduplication, merging of intents, choice of canonical phrasing,
  //    and category assignment MUST come from the LLM via mergedPriorIds / mappedSignalIds / candidate.
  //    No local fuzzy, similarity, or key-based grouping is used for consolidation. The LLM decides.
  const uniquePriors = [...next.preferences];

  // 2. Preprocess extraction candidates. We trust the LLM output exclusively.
  //    (If the LLM returned no candidates this pass, we still carry priors forward for decay + write.)
  const candidatesWithMappings = extraction.candidates.map((candidate) => {
    return {
      ...candidate,
      mergedPriorIds: candidate.mergedPriorIds
        ? [...candidate.mergedPriorIds]
        : [],
      mappedSignalIds: candidate.mappedSignalIds
        ? [...candidate.mappedSignalIds]
        : [],
    };
  });

  // 3. Process candidates and build nextPrefs
  const nextPrefs: Preference[] = [];
  const processedPriorIds = new Set<string>();

  for (const cand of candidatesWithMappings) {
    // Follow LLM-provided mergedPriorIds exactly (no text fuzzy or local key matching).
    // The LLM is responsible for deciding which priors (even cross-category variants) represent
    // the same intent and should be consolidated under this candidate so confidence is refined
    // on a single entry from the full evidence.
    const priors = uniquePriors.filter((p) =>
      cand.mergedPriorIds.includes(p.id),
    );
    const primaryPrior =
      priors.find((p) => p.pinned) ??
      priors.sort((a, b) => b.confidence - a.confidence)[0];

    // Union *all* signals for this intent: the ones the LLM mapped in this candidate *plus*
    // the historical signalIds from every prior the LLM told us to merge. This is what
    // "refine the confidence score" on the consolidated point means.
    const mergedSignalIds = Array.from(
      new Set([
        ...cand.mappedSignalIds,
        ...priors.flatMap((p) => p.signalIds ?? []),
      ]),
    );
    const allEvidenceForIntent = signals.filter((s) =>
      mergedSignalIds.includes(s.id),
    );

    const existingPref = nextPrefs.find((p) =>
      cand.mergedPriorIds.includes(p.id),
    );

    // Validate LLM precision through lightweight structural heuristics
    // so self-scoring doesn't produce overconfident vague rules.
    const validatedPrecision = validatePrecision(cand.preference, cand.precision);

    if (existingPref) {
      existingPref.signalIds = Array.from(
        new Set([...existingPref.signalIds, ...mergedSignalIds]),
      );
      existingPref.supportingSources = Array.from(
        new Set([
          ...existingPref.supportingSources,
          ...collectSources(allEvidenceForIntent),
        ]),
      );
      // Bidirectional precision: blend old and new interpretation.
      // A new weaker interpretation can pull confidence down, preventing
      // overconfidence from a single early strong reading.
      existingPref.confidence = Math.round(
        (existingPref.confidence * 0.3 + validatedPrecision * 0.7) * 100,
      ) / 100;
      // When the new interpretation meaningfully improves phrasing, adopt it.
      if (validatedPrecision > existingPref.confidence) {
        existingPref.preference = cand.preference;
        existingPref.canonicalRuleId = canonicalRuleId(cand.category, cand.preference);
      }
      if (primaryPrior?.pinned) {
        existingPref.confidence = Math.max(primaryPrior.confidence, existingPref.confidence);
        existingPref.pinned = true;
      }
      // Weighted reinforcement — quality-weighted, not just count.
      existingPref.reinforcement = computeReinforcement(allEvidenceForIntent);
      existingPref.evidenceCount = allEvidenceForIntent.length;
      if (allEvidenceForIntent.length > 0) {
        existingPref.lastObservedAt = Math.max(
          existingPref.lastObservedAt,
          ...allEvidenceForIntent.map((s) => s.timestamp),
        );
        existingPref.firstObservedAt = Math.min(
          existingPref.firstObservedAt,
          ...allEvidenceForIntent.map((s) => s.timestamp),
        );
      }
      for (const p of priors) {
        processedPriorIds.add(p.id);
      }
      continue;
    }

    // New preference: validated precision + weighted reinforcement + canonical id.
    let confidence = validatedPrecision;
    if (primaryPrior?.pinned) {
      confidence = Math.max(primaryPrior.confidence, confidence);
    }

    const firstObserved =
      allEvidenceForIntent.length > 0
        ? Math.min(...allEvidenceForIntent.map((e) => e.timestamp))
        : (primaryPrior?.firstObservedAt ?? now);
    const lastObserved =
      allEvidenceForIntent.length > 0
        ? Math.max(...allEvidenceForIntent.map((e) => e.timestamp))
        : (primaryPrior?.lastObservedAt ?? now);

    const pref: Preference = {
      id: primaryPrior?.id ?? newPreferenceId(),
      canonicalRuleId:
        primaryPrior?.canonicalRuleId ??
        canonicalRuleId(cand.category, cand.preference),
      category: cand.category as Domain,
      preference: cand.preference,
      confidence,
      reinforcement: computeReinforcement(allEvidenceForIntent),
      evidenceCount: mergedSignalIds.length,
      firstObservedAt: primaryPrior
        ? Math.min(primaryPrior.firstObservedAt, firstObserved)
        : firstObserved,
      lastObservedAt: primaryPrior
        ? Math.max(primaryPrior.lastObservedAt, lastObserved)
        : lastObserved,
      signalIds: mergedSignalIds,
      supportingSources: Array.from(
        new Set(collectSources(allEvidenceForIntent)),
      ),
      scope: options.scope,
      projectRoot: options.projectRoot,
      pinned: primaryPrior?.pinned ?? false,
      supersededBy: null,
    };
    nextPrefs.push(pref);
    for (const p of priors) {
      processedPriorIds.add(p.id);
    }
  }

  // 4. Carry forward unmapped priors — confidence (interpretation precision)
  //    doesn't decay. Reinforcement and evidence counts are preserved as-is.
  for (const prior of uniquePriors) {
    if (processedPriorIds.has(prior.id)) continue;
    if (isNoisePreference(prior.preference)) continue;
    nextPrefs.push({ ...prior });
  }

  const demoted = nextPrefs.filter(
    (p) => p.confidence < config.demotionThreshold && !p.pinned,
  );
  const kept = nextPrefs.filter(
    (p) => p.confidence >= config.demotionThreshold || p.pinned,
  );
  // Sort by confidence (precision) descending, then by reinforcement for equal precision
  kept.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (b.reinforcement ?? 0) - (a.reinforcement ?? 0);
  });
  const top = kept.slice(0, config.maxPreferences);
  const dropped: Preference[] = [
    ...demoted,
    ...kept.slice(config.maxPreferences),
  ];

  // ── LLM profile refinement pass ──────────────────────────────────
  // After candidate merge, ask the LLM to review the assembled profile
  // for semantic duplicates (clean code = clear code), non-English
  // leakage, and vague rules that survived extraction.
  const { dropIds, mergeMap, updated } = await refineProfileContentWithLLM(
    top.map((p) => ({
      id: p.id,
      category: p.category,
      preference: p.preference,
      confidence: p.confidence,
      pinned: p.pinned,
    })),
    deps,
  );

  // Apply LLM-requested drops and merges
  const refinedTop = top.filter((p) => !dropIds.has(p.id));
  for (const [sourceId, survivorId] of mergeMap) {
    const sourceIdx = refinedTop.findIndex((p) => p.id === sourceId);
    const survivor = refinedTop.find((p) => p.id === survivorId);
    if (sourceIdx >= 0 && survivor) {
      // Merge signal IDs from source into survivor
      const source = refinedTop[sourceIdx]!;
      survivor.signalIds = Array.from(
        new Set([...survivor.signalIds, ...source.signalIds]),
      );
      survivor.supportingSources = Array.from(
        new Set([...survivor.supportingSources, ...source.supportingSources]),
      );
      survivor.evidenceCount += source.evidenceCount;
      dropped.push(source);
      refinedTop.splice(sourceIdx, 1);
    }
  }
  // Apply LLM-updated preference text and confidence
  for (const [id, update] of updated) {
    const pref = refinedTop.find((p) => p.id === id);
    if (pref && !pref.pinned) {
      pref.preference = update.preference;
      pref.confidence = update.confidence;
      pref.canonicalRuleId = canonicalRuleId(pref.category, update.preference);
    }
  }

  const nextProfile: Profile = {
    ...next,
    generatedAt: now,
    preferences: refinedTop,
    summary: next.summary,
    domains: buildDomainProfiles(refinedTop, next.summary, now, config, next.domains),
  };
  nextProfile.summary = nextProfile.summary || generateSummary(refinedTop, config);

  const changes = diffChanges(previous?.preferences ?? [], refinedTop);
  const snapshot: ProfileSnapshot = {
    id: `snap-${now.toString(36)}`,
    scope: options.scope,
    projectRoot: options.projectRoot,
    createdAt: now,
    reason: options.reason ?? "refine",
    profile: nextProfile,
    changes,
    note: options.note ?? null,
  };

  try {
    await storage.saveProfile(nextProfile);
    await storage.appendSnapshot(snapshot);
  } catch (err) {
    console.error(
      "[engineering-profile] storage write failed during refinement:",
      err,
    );
    // Continue — the refinement results are still valid even if persistence
    // had a transient issue. The next refinement pass will retry.
  }

  return {
    profile: nextProfile,
    snapshot,
    added: changes.filter(addedChange).map((c) => c.after as Preference),
    removed: changes.filter(removedChange).map((c) => c.before as Preference),
    modified: changes.filter(modifiedChange).map((c) => c.after as Preference),
    dropped,
  };
}

const addedChange = (
  c: SnapshotChange,
): c is SnapshotChange & { kind: "added" } => c.kind === "added";
const removedChange = (
  c: SnapshotChange,
): c is SnapshotChange & { kind: "removed" } => c.kind === "removed";
const modifiedChange = (
  c: SnapshotChange,
): c is SnapshotChange & { kind: "modified" } => c.kind === "modified";

export async function rollbackTo(
  snapshotId: string,
  scope: Scope,
  projectRoot: string | null,
): Promise<RefineResult | null> {
  const snapshots = await storage.loadSnapshots(scope, projectRoot);
  const target = snapshots.find((s) => s.id === snapshotId);
  if (!target) return null;
  const current = await storage.getProfile(scope, projectRoot);
  const now = Date.now();
  const restored: Profile = {
    ...target.profile,
    generatedAt: now,
    id: target.profile.id,
  };
  const rollback: ProfileSnapshot = {
    id: `snap-${now.toString(36)}`,
    scope,
    projectRoot,
    createdAt: now,
    reason: "rollback",
    profile: restored,
    changes: diffChanges(current?.preferences ?? [], restored.preferences),
    note: `Rollback to ${target.id}`,
  };
  await storage.saveProfile(restored);
  await storage.appendSnapshot(rollback);
  return {
    profile: restored,
    snapshot: rollback,
    added: rollback.changes
      .filter(addedChange)
      .map((c) => c.after as Preference),
    removed: rollback.changes
      .filter(removedChange)
      .map((c) => c.before as Preference),
    modified: rollback.changes
      .filter(modifiedChange)
      .map((c) => c.after as Preference),
    dropped: [],
  };
}

export function diffChanges(
  prev: ReadonlyArray<Preference>,
  next: ReadonlyArray<Preference>,
): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  const prevById = new Map<string, Preference>();
  const nextById = new Map<string, Preference>();
  for (const p of prev) prevById.set(p.id, p);
  for (const p of next) nextById.set(p.id, p);

  for (const [id, n] of nextById) {
    const before = prevById.get(id);
    if (!before) {
      changes.push({
        kind: "added",
        preferenceId: n.id,
        category: n.category,
        before: null,
        after: n,
        confidenceDelta: null,
      });
    } else {
      const merged: Preference = {
        ...before,
        preference: n.preference,
        confidence: n.confidence,
        evidenceCount: n.evidenceCount,
        lastObservedAt: n.lastObservedAt,
        signalIds: n.signalIds,
        supportingSources: n.supportingSources,
        firstObservedAt: Math.min(before.firstObservedAt, n.firstObservedAt),
      };
      if (
        merged.preference !== before.preference ||
        Math.abs(merged.confidence - before.confidence) > 0.01
      ) {
        changes.push({
          kind: "modified",
          preferenceId: merged.id,
          category: merged.category,
          before,
          after: merged,
          confidenceDelta: merged.confidence - before.confidence,
        });
      }
    }
  }
  for (const [id, b] of prevById) {
    if (!nextById.has(id)) {
      changes.push({
        kind: "removed",
        preferenceId: b.id,
        category: b.category,
        before: b,
        after: null,
        confidenceDelta: null,
      });
    }
  }
  return changes;
}

export function buildDomainProfiles(
  prefs: ReadonlyArray<Preference>,
  _globalSummary: string,
  now: number,
  config: RefinementConfig = DEFAULT_REFINEMENT_CONFIG,
  prior: Record<string, DomainProfile> = {},
): Record<string, DomainProfile> {
  const grouped = new Map<Domain, Preference[]>();
  for (const p of prefs) {
    const bucket = grouped.get(p.category) ?? [];
    bucket.push(p);
    grouped.set(p.category, bucket);
  }
  const total = prefs.length || 1;
  const out: Record<string, DomainProfile> = {};
  for (const [domain, list] of grouped) {
    const sorted = list.slice().sort((a, b) => b.confidence - a.confidence);
    const avgConfidence =
      sorted.reduce((s, p) => s + p.confidence, 0) / Math.max(1, sorted.length);
    const share = sorted.length / total;
    const priorDomain = prior[domain];
    const shouldSplit = evaluateSplit({
      preferenceCount: sorted.length,
      averageConfidence: avgConfidence,
      share,
      config,
      priorSplit: priorDomain?.split ?? false,
    });
    const splitPath = shouldSplit
      ? `.xterax/${normalizeDomain(domain)}/profile.md`
      : null;
    out[domain] = {
      category: domain,
      summary: sorted.length > 0 ? generateDomainSummary(domain, sorted) : "",
      preferences: sorted,
      updatedAt: now,
      split: shouldSplit,
      splitPath,
    };
  }
  return out;
}

function evaluateSplit(args: {
  preferenceCount: number;
  averageConfidence: number;
  share: number;
  config: RefinementConfig;
  priorSplit: boolean;
}): boolean {
  const { preferenceCount, averageConfidence, share, config, priorSplit } =
    args;
  const meetsThresholds =
    preferenceCount >= config.splitMinPreferences &&
    averageConfidence >= config.splitMinAverageConfidence &&
    share >= config.splitMinShare;
  if (meetsThresholds) return true;
  return priorSplit;
}

export function generateSummary(
  prefs: ReadonlyArray<Preference>,
  _config: RefinementConfig,
): string {
  if (prefs.length === 0) {
    return "No stable preferences recorded yet.";
  }
  const top = prefs.slice(0, 5);
  const bullets = top.map((p) => p.preference);
  return `Top preferences: ${bullets.join("; ")}.`;
}

export function generateDomainSummary(
  domain: Domain,
  prefs: ReadonlyArray<Preference>,
): string {
  if (prefs.length === 0) return "";
  const top = prefs.slice(0, 3);
  return `${domain}: ${top.map((p) => p.preference).join("; ")}.`;
}

export function resolveConflict(
  user: Preference | null,
  project: Preference | null,
): { effective: Preference | null; overridden: Preference | null } {
  if (!user) return { effective: project, overridden: null };
  if (!project) return { effective: user, overridden: null };
  return { effective: project, overridden: user };
}

export function mergeProfiles(
  user: Profile,
  project: Profile | null,
  now: number,
): Profile {
  if (!project) return user;
  const merged: Preference[] = [];
  const seenIds = new Set<string>();
  // Exact normalized match only (no levenshtein similarity / fuzzy). LLM is the source of truth
  // for intent consolidation; this is just last-resort safety for user vs project overlap.
  const exactMatch = (a: string, b: string) =>
    normalizeText(a) === normalizeText(b);
  for (const up of user.preferences) {
    const conflict = project.preferences.find(
      (p) =>
        p.category === up.category && exactMatch(p.preference, up.preference),
    );
    const { effective, overridden } = resolveConflict(up, conflict ?? null);
    if (effective) {
      merged.push({ ...effective, supersededBy: overridden?.id ?? null });
      seenIds.add(effective.id);
      if (conflict && effective.id !== conflict.id) {
        seenIds.add(conflict.id);
      } else if (conflict) {
        seenIds.add(up.id);
      }
    }
  }
  for (const pp of project.preferences) {
    if (seenIds.has(pp.id)) continue;
    const duplicate = merged.find(
      (m) =>
        m.category === pp.category && exactMatch(m.preference, pp.preference),
    );
    if (duplicate) continue;
    merged.push(pp);
  }
  merged.sort((a, b) => b.confidence - a.confidence);
  return {
    ...user,
    generatedAt: now,
    preferences: merged,
    domains: buildDomainProfiles(merged, user.summary, now, undefined, {
      ...user.domains,
      ...project.domains,
    }),
    summary: user.summary,
  };
}

function cloneProfile(p: Profile, now: number): Profile {
  return {
    ...p,
    generatedAt: now,
    preferences: p.preferences.map((x) => ({ ...x })),
    domains: { ...p.domains },
  };
}

function collectSources(signals: ReadonlyArray<Signal>): SignalSource[] {
  const seen = new Set<SignalSource>();
  for (const s of signals) seen.add(s.source);
  return Array.from(seen);
}

/**
 * Deterministic fallback when LLM extraction returns no usable mappings.
 * Groups raw signals by preference text and wires signal IDs directly.
 */
export function buildFallbackCandidates(
  signals: ReadonlyArray<Signal>,
  priors: ReadonlyArray<Preference>,
): PreferenceCandidate[] {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const key = preferenceKey(s.category, s.preference);
    const bucket = groups.get(key) ?? [];
    bucket.push(s);
    groups.set(key, bucket);
  }
  const out: PreferenceCandidate[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const prior = priors.find(
      (p) =>
        preferenceKey(p.category, p.preference) ===
        preferenceKey(first.category, first.preference),
    );
    out.push({
      category: first.category,
      preference: first.preference,
      precision: 0.4, // deterministic fallback: moderate uncertainty, no LLM interpretation
      evidence: first.evidence,
      weight: 1,
      mergedPriorIds: prior ? [prior.id] : [],
      mappedSignalIds: group.map((s) => s.id),
    });
  }
  return out;
}

export const _internal = {};
