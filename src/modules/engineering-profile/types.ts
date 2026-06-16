/**
 * Core types for the Engineering Profile system.
 *
 * The profile is a hierarchical, evidence-backed map of engineering
 * preferences. It separates signals (raw observations) from preferences
 * (refined, confidence-scored beliefs) and snapshots (immutable history
 * points used for diff/rollback).
 *
 * Domains are free-form strings — discovery is data-driven, not closed.
 * The DOMAIN_HINTS list is a small hint set used by the observer to
 * auto-categorize signals; the system will accept and store any string
 * a caller provides.
 */

export type Domain = string;

export const DOMAIN_HINTS: readonly string[] = [
  "architecture",
  "frontend",
  "backend",
  "design",
  "ux",
  "testing",
  "documentation",
  "workflow",
  "general",
];

export const DOMAIN_HINT_SET: ReadonlySet<string> = new Set(DOMAIN_HINTS);

export const DEFAULT_DOMAIN = "general";

/**
 * Returns true if `value` is a non-empty string. The system does NOT
 * validate against a closed list — any string is a valid domain.
 */
export function isDomain(value: string): value is Domain {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Returns true if `value` matches one of the known hint categories. The
 * observer uses this for auto-categorization; it is never used as a
 * rejection criterion (unknown strings are still valid domains).
 */
export function isKnownDomainHint(value: string): boolean {
  return DOMAIN_HINT_SET.has(value);
}

/**
 * Normalizes a free-form domain string. Used by storage so directories
 * are filesystem-safe while the in-memory domain remains the original
 * casing the user provided.
 */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export type SignalSource =
  | "explicit-feedback"
  | "accepted-change"
  | "rejected-change"
  | "user-modification"
  | "architecture-decision"
  | "recurring-request"
  | "design-critique"
  | "workflow-instruction"
  | "config-setting";

export const SIGNAL_SOURCES: readonly SignalSource[] = [
  "explicit-feedback",
  "accepted-change",
  "rejected-change",
  "user-modification",
  "architecture-decision",
  "recurring-request",
  "design-critique",
  "workflow-instruction",
  "config-setting",
] as const;

export type Scope = "user" | "project";

export type Signal = {
  id: string;
  timestamp: number;
  source: SignalSource;
  scope: Scope;
  projectRoot: string | null;
  category: Domain;
  preference: string;
  evidence: string;
  weight: number;
};

export type Preference = {
  id: string;
  category: Domain;
  preference: string;
  confidence: number;
  evidenceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  signalIds: string[];
  supportingSources: SignalSource[];
  scope: Scope;
  projectRoot: string | null;
  pinned: boolean;
  supersededBy: string | null;
};

export type DomainProfile = {
  category: Domain;
  summary: string;
  preferences: Preference[];
  updatedAt: number;
  /**
   * Whether this domain has been split into its own .terax/<domain>/
   * subdirectory. When true, the root profile.md contains a short
   * reference ("See .terax/<domain>/profile.md") and the full list
   * lives in the subdirectory file. Refinement decides this based on
   * the configured split thresholds.
   */
  split: boolean;
  /**
   * The on-disk path to the split subdirectory file, relative to the
   * project root. Only set when `split` is true. Format:
   * ".terax/<domain>/profile.md" with the domain slug normalized.
   */
  splitPath: string | null;
};

export type Profile = {
  id: string;
  scope: Scope;
  projectRoot: string | null;
  generatedAt: number;
  summary: string;
  preferences: Preference[];
  /**
   * Domain profiles, keyed by domain name. Sparse — only domains that
   * have at least one preference appear here. The system does not
   * enumerate a closed set of domains; new ones appear as preferences
   * are observed.
   */
  domains: Record<string, DomainProfile>;
};

export type SnapshotChangeKind = "added" | "removed" | "modified";

export type SnapshotChange = {
  kind: SnapshotChangeKind;
  preferenceId: string;
  category: Domain;
  before: Preference | null;
  after: Preference | null;
  confidenceDelta: number | null;
};

export type ProfileSnapshot = {
  id: string;
  scope: Scope;
  projectRoot: string | null;
  createdAt: number;
  reason: "initial" | "refine" | "rollback" | "manual";
  profile: Profile;
  changes: SnapshotChange[];
  note: string | null;
};

export type RefinementProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "groq"
  | "openrouter"
  | "openai-compatible"
  | "lmstudio"
  | "mlx"
  | "ollama"
  | "heuristic";

export type RefinementConfig = {
  provider: RefinementProvider;
  modelId: string;
  minConfidence: number;
  maxAgeMs: number;
  decayHalfLifeMs: number;
  promotionThreshold: number;
  demotionThreshold: number;
  maxPreferences: number;
  /**
   * Domain-split thresholds. A domain is split into its own
   * .terax/<domain>/profile.md when ALL of these are met:
   *   - preference count >= splitMinPreferences
   *   - average confidence >= splitMinAverageConfidence
   *   - share of total profile >= splitMinShare
   * The refinement workflow is the only place this is evaluated; the
   * storage layer is purely passive.
   */
  splitMinPreferences: number;
  splitMinAverageConfidence: number;
  splitMinShare: number;
};

export const DEFAULT_REFINEMENT_CONFIG: RefinementConfig = {
  provider: "heuristic",
  modelId: "engineering-profile-heuristic-v1",
  minConfidence: 0.35,
  maxAgeMs: 180 * 24 * 60 * 60 * 1000,
  decayHalfLifeMs: 60 * 24 * 60 * 60 * 1000,
  promotionThreshold: 0.7,
  demotionThreshold: 0.25,
  maxPreferences: 240,
  splitMinPreferences: 5,
  splitMinAverageConfidence: 0.6,
  splitMinShare: 0.25,
};

export type PreferenceCandidate = {
  category: Domain;
  preference: string;
  evidence: string;
  weight: number;
};

export type ExtractionResult = {
  candidates: PreferenceCandidate[];
  discarded: { text: string; reason: string }[];
  provider: RefinementProvider;
};

export type LoadedProfiles = {
  user: Profile;
  project: Profile | null;
};

export type ExplainEvidence = {
  signalId: string;
  timestamp: number;
  source: SignalSource;
  scope: Scope;
  evidence: string;
  weight: number;
};

export type PreferenceExplanation = {
  preference: Preference;
  effectiveScope: Scope;
  overriddenBy: Preference | null;
  evidence: ExplainEvidence[];
  totalWeight: number;
  sourceBreakdown: Partial<Record<SignalSource, number>>;
};

export const SOURCE_WEIGHTS: Record<SignalSource, number> = {
  "explicit-feedback": 1.0,
  "architecture-decision": 0.9,
  "design-critique": 0.85,
  "workflow-instruction": 0.8,
  "recurring-request": 0.6,
  "accepted-change": 0.5,
  "config-setting": 0.5,
  "user-modification": 0.45,
  "rejected-change": -0.7,
};

export function scopeFolder(scope: Scope, projectRoot: string | null): string {
  if (scope === "user") return "user";
  return projectRoot ? `project:${projectRoot}` : "project:default";
}
