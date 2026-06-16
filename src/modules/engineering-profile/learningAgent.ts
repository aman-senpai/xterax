/**
 * The Autonomous Continuous Learning Agent.
 *
 * Runs in its own loop, completely separate from the main chat agent
 * and from any subagents. The chat agent and subagents do NOT see this
 * code; they are consumers of the resulting .terax/profile.md, not
 * participants in the learning process.
 *
 * The agent observes:
 *   - new preference signals (from the user via the passive observer
 *     or from the chat agent via the recording tool)
 *   - tool call rejections (the user said "no" to something the agent
 *     proposed)
 *   - user file edits (a Rust-side fs watcher reports paths the user
 *     modified; if the file is a signal-recording tool, it's a strong
 *     feedback signal)
 *   - chat completions (a turn finished — time to do an idle refinement
 *     pass if the signal queue is non-empty)
 *
 * It acts by:
 *   - running LLM extraction to convert raw signals into structured
 *     preference candidates
 *   - running refinement to merge candidates into confidence-scored
 *     preferences and decide on domain splits
 *   - writing .terax/profile.json and .terax/profile.md (and split
 *     subdirectory files) without approval
 *   - updating the engine's self-state (which sources of signal are
 *     yielding the most reliable preferences, so future extraction
 *     weights them higher)
 *
 * Triggers (any of these wake the agent):
 *   - `notifySignalRecorded()` — called whenever a new signal lands
 *   - `notifyChatTurnFinished()` — called when the chat agent finishes
 *   - `notifyToolRejection()` — called when the user rejects a tool
 *     approval (downward signal)
 *   - idle tick (every IDLE_INTERVAL_MS) — sweeps pending signals even
 *     if no event has fired
 *
 * Throttling: refinement runs at most every `MIN_REFINEMENT_INTERVAL_MS`
 * in response to events. The idle tick is throttled separately.
 */

import { observeUserMessage } from "./observer";
import { refineProfile } from "./refinement";
import { storage, getCachedConfig } from "./storage";
import { useChatStore } from "@/modules/ai/store/chatStore";
import type { ExtractorDeps } from "./extraction";
import type { Profile, Scope, Signal } from "./types";

const MIN_REFINEMENT_INTERVAL_MS = 4000;
const IDLE_INTERVAL_MS = 90_000;
const IDLE_MIN_PENDING_SIGNALS = 1;
const SIGNAL_SINCE_LAST_REFINE_KEY = "agent.signalCount";
const LAST_REFINE_AT_KEY = "agent.lastRefineAt";

export type AgentState = {
  status: "idle" | "observing" | "refining" | "writing" | "error";
  lastRefineAt: number;
  signalsSinceLastRefine: number;
  totalRefinements: number;
  lastError: string | null;
  lastSummary: string;
  startedAt: number;
};

const state: AgentState = {
  status: "idle",
  lastRefineAt: 0,
  signalsSinceLastRefine: 0,
  totalRefinements: 0,
  lastError: null,
  lastSummary: "Not yet started",
  startedAt: Date.now(),
};

const listeners = new Set<(s: AgentState) => void>();

export function getAgentState(): Readonly<AgentState> {
  return state;
}

export function subscribeAgent(listener: (s: AgentState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const l of listeners) l(state);
}

function setState(patch: Partial<AgentState>): void {
  Object.assign(state, patch);
  emit();
}

let schedulerStarted = false;
let projectRoot: string | null = null;

export function startLearningAgent(root: string | null): void {
  projectRoot = root;
  if (schedulerStarted) return;
  schedulerStarted = true;
  setState({
    startedAt: Date.now(),
    lastSummary: root
      ? `Watching ${root} for preference signals`
      : "Waiting for workspace",
  });
  const idle = setInterval(() => {
    void idleTick();
  }, IDLE_INTERVAL_MS);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => clearInterval(idle));
  }
  void initialSweep();
}

export function stopLearningAgent(): void {
  schedulerStarted = false;
  setState({ status: "idle" });
}

export function _resetAgentForTests(): void {
  state.status = "idle";
  state.lastRefineAt = 0;
  state.signalsSinceLastRefine = 0;
  state.totalRefinements = 0;
  state.lastError = null;
  state.lastSummary = "Not yet started";
  state.startedAt = Date.now();
  schedulerStarted = false;
  projectRoot = null;
  emit();
}

export function setAgentProjectRoot(root: string | null): void {
  projectRoot = root;
  if (root) {
    setState({ lastSummary: `Watching ${root} for preference signals` });
  }
}

export function notifySignalRecorded(signal: Signal): void {
  state.signalsSinceLastRefine++;
  emit();
  void maybeRefine("signal", signal);
}

export function notifyChatTurnFinished(): void {
  void maybeRefine("turn-finished");
}

export function notifyToolRejection(toolName: string, reason: string): void {
  void observeUserMessage({
    text: `Don't use ${toolName} that way: ${reason}`,
    projectRoot,
  }).then(() => {
    void maybeRefine("rejection");
  });
}

export function notifyUserFileEdit(filePath: string, summary: string): void {
  const isProfileFile =
    filePath.endsWith("/.terax/profile.md") ||
    filePath.endsWith("/.terax/profile.json");
  if (isProfileFile) return;
  const text = `User edited ${filePath}: ${summary}`;
  void observeUserMessage({ text, projectRoot }).then(() => {
    void maybeRefine("user-edit");
  });
}

async function idleTick(): Promise<void> {
  if (state.signalsSinceLastRefine < IDLE_MIN_PENDING_SIGNALS) return;
  await maybeRefine("idle-tick");
}

async function initialSweep(): Promise<void> {
  if (!projectRoot) return;
  try {
    const signals = await storage.loadSignals("user", null);
    if (signals.length > 0) {
      await maybeRefine("initial-sweep");
    }
  } catch {
    /* storage may not be ready yet */
  }
}

async function maybeRefine(
  trigger: "signal" | "turn-finished" | "rejection" | "user-edit" | "idle-tick" | "initial-sweep",
  _signal?: Signal,
): Promise<void> {
  const now = Date.now();
  if (state.status === "refining" || state.status === "writing") return;
  if (now - state.lastRefineAt < MIN_REFINEMENT_INTERVAL_MS) return;
  if (state.signalsSinceLastRefine === 0 && trigger !== "initial-sweep") return;
  await runRefinePass(trigger);
}

async function runRefinePass(
  trigger: string,
): Promise<void> {
  if (!projectRoot) {
    setState({ status: "idle", lastSummary: "No workspace anchored yet" });
    return;
  }
  setState({ status: "observing", lastSummary: `Triggered by ${trigger}` });
  const t0 = Date.now();
  try {
    const deps = makeExtractorDeps();
    setState({ status: "refining", lastSummary: "Refining profile (LLM pass)" });
    const projectResult = await refineProfile(deps, {
      scope: "project",
      projectRoot,
      note: `auto-refine (${trigger})`,
    });
    setState({ status: "writing", lastSummary: "Writing profile.md" });
    state.signalsSinceLastRefine = 0;
    state.lastRefineAt = Date.now();
    state.totalRefinements++;
    setState({
      status: "idle",
      lastSummary: `Refined ${projectResult.added.length} added, ${projectResult.removed.length} removed, ${projectResult.modified.length} modified in ${Date.now() - t0}ms`,
      lastError: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setState({ status: "error", lastError: msg, lastSummary: `Error: ${msg}` });
  }
}

function makeExtractorDeps(): ExtractorDeps {
  const chat = useChatStore.getState();
  return {
    getKeys: () => chat.apiKeys,
    getModelId: () => chat.selectedModelId,
    getLocalConfig: () => undefined,
    getConfig: () => getCachedConfig(),
  };
}

export async function forceRefine(
  scope: Scope,
  projectRootOverride: string | null,
): Promise<void> {
  const root = projectRootOverride ?? projectRoot;
  if (!root) return;
  const deps = makeExtractorDeps();
  await refineProfile(deps, { scope, projectRoot: root, note: "forced by user" });
  state.lastRefineAt = Date.now();
  state.signalsSinceLastRefine = 0;
  setState({
    status: "idle",
    lastSummary: `Forced refinement (${scope})`,
    totalRefinements: state.totalRefinements + 1,
  });
}

export async function forceRefineSync(
  scope: Scope,
  projectRootOverride: string | null,
): Promise<Profile | null> {
  const root = projectRootOverride ?? projectRoot;
  if (!root) return null;
  const deps = makeExtractorDeps();
  const result = await refineProfile(deps, { scope, projectRoot: root, note: "forced sync" });
  state.lastRefineAt = Date.now();
  state.signalsSinceLastRefine = 0;
  setState({
    status: "idle",
    lastSummary: `Forced sync refinement (${scope})`,
    totalRefinements: state.totalRefinements + 1,
  });
  return result.profile;
}

export { state as _state };

export const LEARNING_AGENT_INTERNALS = {
  MIN_REFINEMENT_INTERVAL_MS,
  IDLE_INTERVAL_MS,
  IDLE_MIN_PENDING_SIGNALS,
  SIGNAL_SINCE_LAST_REFINE_KEY,
  LAST_REFINE_AT_KEY,
};
