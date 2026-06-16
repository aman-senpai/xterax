// Public API barrel for the Engineering Profile system.
//
// Storage, signals, refinement, runtime injection, and AI tools are exposed
// here for use by App-level wiring, tests, and any future UI surface
// (e.g. a profile inspector panel).

export type {
  Domain,
  DomainProfile,
  LoadedProfiles,
  Preference,
  PreferenceCandidate,
  PreferenceExplanation,
  ExplainEvidence,
  Profile,
  ProfileSnapshot,
  RefinementConfig,
  RefinementProvider,
  Scope,
  Signal,
  SignalSource,
  SnapshotChange,
  ExtractionResult,
} from "./types";
export type { RefineResult } from "./refinement";
export {
  DEFAULT_REFINEMENT_CONFIG,
  DOMAIN_HINTS,
  DOMAIN_HINT_SET,
  DEFAULT_DOMAIN,
  isDomain,
  isKnownDomainHint,
  normalizeDomain,
  SIGNAL_SOURCES,
  SOURCE_WEIGHTS,
} from "./types";

export {
  aggregateScore,
  clamp01,
  distinctSourceCount,
  logistic,
  normalizeConfidence,
  normalizeText,
  preferenceKey,
  similarity,
  totalWeight,
} from "./confidence";

export {
  buildContextPackage,
  classifyTask,
  explainPreference,
  loadProfiles,
  renderContextPackageForPrompt,
} from "./runtime";
export type { ContextBlock, ContextPackage } from "./runtime";

export {
  refineProfile,
  rollbackTo,
  diffChanges,
  buildDomainProfiles,
  mergeProfiles,
  resolveConflict,
} from "./refinement";

export {
  getMergedProfile,
  getProfile,
  getRefinementConfig,
  listProjectProfiles,
  refineProjectProfile,
  refineUserProfile,
  rollbackProfile,
  setRefinementConfig,
  showProfileHistory,
  showSignals,
  defaultDeps,
} from "./api";
export type { EngineeringProfileDeps } from "./api";

export {
  recordSignal,
  recordSignals,
  recordAcceptedChange,
  recordRejectedChange,
  recordUserModification,
  recordArchitectureDecision,
  recordRecurringRequest,
  recordDesignCritique,
  recordWorkflowInstruction,
  recordConfigSetting,
  recordExplicitFeedback,
  loadSignals,
} from "./signals";
export type { RecordSignalInput, RecordSignalResult } from "./signals";

export { buildProfileTools } from "./tools";
export { storage, makeBlankProfile } from "./storage";
export { heuristicExtractor, llmExtractor, pickExtractor } from "./extraction";
export type { Extractor, ExtractorDeps } from "./extraction";
export { observeUserMessage } from "./observer";
export type { ObservationInput, ObservationResult } from "./observer";
export { ensureBootstrap, bootstrapPath } from "./bootstrap";
export {
  anchorProjectRoot,
  getAnchoredProjectRoot,
  resetAnchoredProjectRoot,
} from "./projectRoot";
export {
  startLearningAgent,
  stopLearningAgent,
  setAgentProjectRoot,
  notifySignalRecorded,
  notifyChatTurnFinished,
  notifyToolRejection,
  notifyUserFileEdit,
  getAgentState,
  subscribeAgent,
  forceRefine,
  forceRefineSync,
} from "./learningAgent";
export type { AgentState } from "./learningAgent";
export { LearningAgentPill } from "./StatusPill";
