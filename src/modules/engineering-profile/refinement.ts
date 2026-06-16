import {
  aggregateScore,
  clamp01,
  distinctSourceCount,
  normalizeConfidence,
  normalizeText,
  preferenceKey,
  similarity,
} from "./confidence";
import { makeBlankProfile, newPreferenceId, storage } from "./storage";
import {
  DEFAULT_REFINEMENT_CONFIG,
  normalizeDomain,
  type Domain,
  type DomainProfile,
  type Preference,
  type Profile,
  type ProfileSnapshot,
  type RefinementConfig,
  type Scope,
  type Signal,
  type SignalSource,
  type SnapshotChange,
} from "./types";
import { pickExtractor, type Extractor, type ExtractorDeps } from "./extraction";

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
 *  2. Run extraction (LLM or heuristic) to produce candidates.
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
  const previous = await storage.getProfile(options.scope, options.projectRoot);
  const signals = await storage.loadSignals(options.scope, options.projectRoot);
  const extractor: Extractor = pickExtractor(config);
  const extraction = await extractor(signals, deps);
  const next = previous
    ? cloneProfile(previous, now)
    : makeBlankProfile(options.scope, options.projectRoot, now);

  const all = new Map<string, Signal[]>();
  for (const s of signals) {
    const k = preferenceKey(s.category, s.preference);
    let bucket = all.get(k);
    if (!bucket) {
      bucket = [];
      all.set(k, bucket);
    }
    bucket.push(s);
  }

  const nextPrefs: Preference[] = [];
  const newKeys = new Set<string>();
  for (const [key, evSignals] of all) {
    newKeys.add(key);
    const prior = next.preferences.find((p) => preferenceKey(p.category, p.preference) === key);
    const candidate = extraction.candidates.find(
      (c) => preferenceKey(c.category, c.preference) === key,
    );
    const evidence = evSignals;
    const rawScore = aggregateScore(evidence, now, config);
    let confidence = normalizeConfidence(rawScore, evidence);
    if (prior?.pinned) {
      confidence = Math.max(prior.confidence, confidence);
    }
    if (prior && candidate && normalizeText(prior.preference) !== normalizeText(candidate.preference)) {
      confidence = (confidence + prior.confidence) / 2;
    }
    const sources = collectSources(evidence);
    const pref: Preference = {
      id: prior?.id ?? newPreferenceId(),
      category: (candidate?.category ?? prior?.category ?? evidence[0]?.category ?? "general") as Domain,
      preference: candidate?.preference ?? prior?.preference ?? evidence[0]?.preference,
      confidence,
      evidenceCount: evidence.length,
      firstObservedAt:
        prior?.firstObservedAt ??
        Math.min(...evidence.map((e) => e.timestamp)),
      lastObservedAt: Math.max(...evidence.map((e) => e.timestamp)),
      signalIds: evidence.map((e) => e.id),
      supportingSources: sources,
      scope: options.scope,
      projectRoot: options.projectRoot,
      pinned: prior?.pinned ?? false,
      supersededBy: null,
    };
    nextPrefs.push(pref);
  }

  const demoted = nextPrefs.filter((p) => p.confidence < config.demotionThreshold && !p.pinned);
  const kept = nextPrefs.filter((p) => p.confidence >= config.demotionThreshold || p.pinned);
  kept.sort((a, b) => b.confidence - a.confidence);
  const top = kept.slice(0, config.maxPreferences);
  const dropped: Preference[] = [
    ...demoted,
    ...kept.slice(config.maxPreferences),
  ];
  top.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.lastObservedAt - a.lastObservedAt;
  });

  const nextProfile: Profile = {
    ...next,
    generatedAt: now,
    preferences: top,
    summary: next.summary,
    domains: buildDomainProfiles(
      top,
      next.summary,
      now,
      config,
      next.domains,
    ),
  };
  nextProfile.summary = nextProfile.summary || generateSummary(top, config);

  const changes = diffChanges(previous?.preferences ?? [], top);
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

  await storage.saveProfile(nextProfile);
  await storage.appendSnapshot(snapshot);

  return {
    profile: nextProfile,
    snapshot,
    added: changes.filter(addedChange).map((c) => c.after as Preference),
    removed: changes.filter(removedChange).map((c) => c.before as Preference),
    modified: changes.filter(modifiedChange).map((c) => c.after as Preference),
    dropped,
  };
}

const addedChange = (c: SnapshotChange): c is SnapshotChange & { kind: "added" } => c.kind === "added";
const removedChange = (c: SnapshotChange): c is SnapshotChange & { kind: "removed" } => c.kind === "removed";
const modifiedChange = (c: SnapshotChange): c is SnapshotChange & { kind: "modified" } => c.kind === "modified";

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
  const prevByKey = new Map<string, Preference>();
  const nextByKey = new Map<string, Preference>();
  for (const p of prev) prevByKey.set(preferenceKey(p.category, p.preference), p);
  for (const p of next) nextByKey.set(preferenceKey(p.category, p.preference), p);
  for (const [k, n] of nextByKey) {
    const before = prevByKey.get(k);
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
  for (const [k, b] of prevByKey) {
    if (!nextByKey.has(k)) {
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
      ? `.terax/${normalizeDomain(domain)}/profile.md`
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
  const { preferenceCount, averageConfidence, share, config, priorSplit } = args;
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
  if (similarity(user.preference, project.preference) < 0.7) {
    return { effective: project, overridden: user };
  }
  if (Math.abs(user.confidence - project.confidence) < 0.1) {
    return { effective: project, overridden: user };
  }
  if (project.confidence > user.confidence) {
    return { effective: project, overridden: user };
  }
  return { effective: project, overridden: user };
}

export function mergeProfiles(
  user: Profile,
  project: Profile | null,
  now: number,
): Profile {
  if (!project) return user;
  const merged: Preference[] = [];
  const seen = new Set<string>();
  for (const up of user.preferences) {
    const k = preferenceKey(up.category, up.preference);
    const conflict = project.preferences.find(
      (p) => preferenceKey(p.category, p.preference) === k,
    );
    const { effective, overridden } = resolveConflict(
      up,
      conflict ?? null,
    );
    if (effective) {
      merged.push({ ...effective, supersededBy: overridden?.id ?? null });
      seen.add(preferenceKey(effective.category, effective.preference));
    }
  }
  for (const pp of project.preferences) {
    const k = preferenceKey(pp.category, pp.preference);
    if (seen.has(k)) continue;
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

export const _internal = {
  clamp01,
  distinctSourceCount,
};
