// Public API barrel for the Engineering Profile system.
//
// Storage, signals, refinement, runtime injection, and AI tools are exposed
// here for use by App-level wiring, tests, and any future UI surface
// (e.g. a profile inspector panel).

export type { EngineeringProfileDeps } from "./api";
export {
  defaultDeps,
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
} from "./api";
export {
  bootstrapPath,
  ensureBootstrap,
  resetProjectStoreIfMirrorMissing,
} from "./bootstrap";
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
export type { Extractor, ExtractorDeps } from "./extraction";
export { llmExtractor, pickExtractor, supportsProvider } from "./extraction";
export type { AgentState } from "./learningAgent";
export {
  forceRefine,
  forceRefineSync,
  getAgentState,
  notifyChatTurnFinished,
  notifySignalRecorded,
  notifyToolRejection,
  notifyUserFileEdit,
  notifyUserMessageSent,
  setAgentProjectRoot,
  startLearningAgent,
  stopLearningAgent,
  subscribeAgent,
} from "./learningAgent";
export type { ObservationInput, ObservationResult } from "./observer";
export { observeUserMessage } from "./observer";
export {
  anchorProjectRoot,
  getAnchoredProjectRoot,
  resetAnchoredProjectRoot,
  resolveProfileProjectRoot,
} from "./projectRoot";
export type { RefineResult } from "./refinement";
export {
  buildDomainProfiles,
  diffChanges,
  mergeProfiles,
  refineProfile,
  resolveConflict,
  rollbackTo,
} from "./refinement";
export type { ContextBlock, ContextPackage } from "./runtime";
export {
  buildContextPackage,
  classifyTask,
  explainPreference,
  loadProfiles,
  renderContextPackageForPrompt,
} from "./runtime";
export { LearningAgentPill } from "./StatusPill";
export type { RecordSignalInput, RecordSignalResult } from "./signals";
export {
  loadSignals,
  recordAcceptedChange,
  recordArchitectureDecision,
  recordConfigSetting,
  recordDesignCritique,
  recordExplicitFeedback,
  recordRecurringRequest,
  recordRejectedChange,
  recordSignal,
  recordSignals,
  recordUserModification,
  recordWorkflowInstruction,
} from "./signals";
export { makeBlankProfile, storage } from "./storage";
export { buildProfileTools } from "./tools";
export type {
  Domain,
  DomainProfile,
  ExplainEvidence,
  ExtractionResult,
  LoadedProfiles,
  Preference,
  PreferenceCandidate,
  PreferenceExplanation,
  Profile,
  ProfileSnapshot,
  RefinementConfig,
  RefinementProvider,
  Scope,
  Signal,
  SignalSource,
  SnapshotChange,
} from "./types";
export {
  DEFAULT_DOMAIN,
  DEFAULT_REFINEMENT_CONFIG,
  DOMAIN_HINT_SET,
  DOMAIN_HINTS,
  isDomain,
  isKnownDomainHint,
  normalizeDomain,
  SIGNAL_SOURCES,
  SOURCE_WEIGHTS,
} from "./types";
