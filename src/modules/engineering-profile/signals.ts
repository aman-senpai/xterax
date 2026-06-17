import {
  isDomain,
  type Domain,
  type Scope,
  type Signal,
  type SignalSource,
} from "./types";
import { newSignalId, storage, projectMirrorExists, clearProjectData } from "./storage";
import { ensureBootstrap } from "./bootstrap";

export type RecordSignalInput = {
  source: SignalSource;
  category: Domain | string;
  preference: string;
  evidence: string;
  weight?: number;
  scope?: Scope;
  projectRoot?: string | null;
  timestamp?: number;
};

export type RecordSignalResult = {
  signal: Signal;
  accepted: boolean;
  reason?: string;
};

const NOISE_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^(ok|okay|sure|thanks|thx|ty|got it|done|nice|lgtm|yep|yeah|no|nope|k)\s*\.?$/i,
  /^please (do|run|execute|try)/i,
  /^(can you|could you|would you|will you)/i,
];

const PREFERENCE_TOO_SHORT = 3;
const PREFERENCE_MAX_LEN = 280;

/**
 * Records a single preference signal. The signal is append-only — never
 * updated, never deleted. Returns the persisted signal (or a reason it
 * was filtered as noise).
 *
 * The signal is not a preference yet. It is a raw observation that
 * refinement later aggregates into a confidence-scored preference.
 *
 * On the first project-scoped signal in a workspace, this also
 * bootstraps the .terax/ directory structure.
 */
export async function recordSignal(
  input: RecordSignalInput,
): Promise<RecordSignalResult> {
  const text = input.preference?.trim() ?? "";
  const evidence = input.evidence?.trim() ?? "";
  if (text.length < PREFERENCE_TOO_SHORT) {
    return { signal: emptySignal(), accepted: false, reason: "too-short" };
  }
  if (text.length > PREFERENCE_MAX_LEN) {
    return { accepted: false, reason: "too-long", signal: emptySignal() };
  }
  for (const re of NOISE_PATTERNS) {
    if (re.test(text)) {
      return { accepted: false, reason: "noise", signal: emptySignal() };
    }
  }
  const category: Domain = isDomain(input.category)
    ? input.category
    : "general";
  const scope: Scope = input.scope ?? (input.projectRoot ? "project" : "user");
  const projectRoot = scope === "project" ? (input.projectRoot ?? null) : null;
  const signal: Signal = {
    id: newSignalId(),
    timestamp: input.timestamp ?? Date.now(),
    source: input.source,
    scope,
    projectRoot,
    category,
    preference: text,
    evidence,
    weight: clampWeight(input.weight ?? 1),
  };
  if (projectRoot) {
    // Before (re)creating the mirror, check if it was missing. If the user
    // deleted .terax/, this is a reset signal: clear global store data first
    // so we start the new .terax/ from a true blank canvas.
    if (!(await projectMirrorExists(projectRoot))) {
      await clearProjectData(projectRoot);
    }
    await ensureBootstrap(projectRoot);
  }
  await storage.appendSignal(signal);
  void notifyLearningAgent(signal);
  return { signal, accepted: true };
}

function notifyLearningAgent(signal: Signal): void {
  void import("./learningAgent").then((m) => {
    try {
      m.notifySignalRecorded(signal);
    } catch (err) {
      console.warn("[engineering-profile] learning agent notify failed:", err);
    }
  });
}

export async function recordSignals(
  inputs: ReadonlyArray<RecordSignalInput>,
): Promise<RecordSignalResult[]> {
  const out: RecordSignalResult[] = [];
  for (const i of inputs) {
    out.push(await recordSignal(i));
  }
  return out;
}

export async function recordExplicitFeedback(
  preference: string,
  evidence: string,
  opts?: {
    category?: Domain | string;
    projectRoot?: string | null;
    weight?: number;
  },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "explicit-feedback",
    category: opts?.category ?? "general",
    preference,
    evidence,
    weight: opts?.weight,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordAcceptedChange(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "accepted-change",
    category: opts?.category ?? "general",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordRejectedChange(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "rejected-change",
    category: opts?.category ?? "general",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordUserModification(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "user-modification",
    category: opts?.category ?? "general",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordRecurringRequest(
  preference: string,
  evidence: string,
  opts?: {
    category?: Domain | string;
    projectRoot?: string | null;
    weight?: number;
  },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "recurring-request",
    category: opts?.category ?? "general",
    preference,
    evidence,
    weight: opts?.weight ?? 0.7,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordArchitectureDecision(
  preference: string,
  evidence: string,
  opts?: { projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "architecture-decision",
    category: "architecture",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordDesignCritique(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "design-critique",
    category: opts?.category ?? "design",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordWorkflowInstruction(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "workflow-instruction",
    category: opts?.category ?? "workflow",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

export async function recordConfigSetting(
  preference: string,
  evidence: string,
  opts?: { category?: Domain | string; projectRoot?: string | null },
): Promise<RecordSignalResult> {
  return recordSignal({
    source: "config-setting",
    category: opts?.category ?? "general",
    preference,
    evidence,
    scope: opts?.projectRoot ? "project" : "user",
    projectRoot: opts?.projectRoot ?? null,
  });
}

function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 1;
  if (w < 0) return 0;
  if (w > 2) return 2;
  return w;
}

function emptySignal(): Signal {
  return {
    id: "",
    timestamp: 0,
    source: "explicit-feedback",
    scope: "user",
    projectRoot: null,
    category: "general",
    preference: "",
    evidence: "",
    weight: 0,
  };
}

export async function loadSignals(
  scope: Scope,
  projectRoot: string | null,
): Promise<Signal[]> {
  return storage.loadSignals(scope, projectRoot);
}
