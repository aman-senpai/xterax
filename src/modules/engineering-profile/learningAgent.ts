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
 *   - writing .terax/profile.md (and split subdirectory files) without approval
 *   - updating the engine's self-state (which sources of signal are
 *     yielding the most reliable preferences, so future extraction
 *     weights them higher)
 *
 * Triggers for *signals* (cheap observation/recording):
 *   - `notifySignalRecorded()` — from record_preference_signal tool or
 *     passive observer on user messages (and some other paths).
 *   - Feedback on turns (accept/reject signals from runFeedbackForTurn).
 *
 * Refinement (the LLM extractor + merge/consolidation step, i.e. the
 * costly part) is **only** driven by new user-sent chat messages:
 *   - `notifyUserMessageSent()` — called from the composer when the user
 *     submits a message. This is the single controlled entry point.
 *     Any accumulated signals (from observer, agent tool calls during
 *     the turn, feedback, rejections, etc.) are processed then.
 *
 * Intelligence / cost control:
 *   - maybeRefine has built-in guards (throttle, in-flight lock,
 *     signalsSinceLastRefine > 0, scopesNeedingRefine checking real
 *     stored signals, bootstrap check).
 *   - No more automatic refinement on every agent turn-finished,
 *     idle tick, or most file edits. This prevents over-calling the
 *     generateObject extractor (and the resulting profile writes).
 *   - Feedback/RL still runs cheaply on turns.
 *   - Initial sweep on agent start (tied to first user message in session).
 *
 * Throttling: refinement runs at most every `MIN_REFINEMENT_INTERVAL_MS`
 * when triggered.
 */

import { observeUserMessage } from "./observer";
import { refineProfile, type RefineResult } from "./refinement";
import { storage } from "./storage";
import type { Profile, Scope, Signal } from "./types";
import {
  acquireRefineLock,
  markRefineInFlight,
  makeExtractorDeps,
} from "./autoRefine";
import { getAnchoredProjectRoot } from "./projectRoot";

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

let schedulerStarted = false;
let projectRoot: string | null = null;
let idleInterval: NodeJS.Timeout | any = null;
let patternMinerInterval: NodeJS.Timeout | any = null;
let turnHadRejection = false;

export function getAgentState(): Readonly<AgentState> {
  return { ...state };
}

export function subscribeAgent(listener: (s: Readonly<AgentState>) => void): () => void {
  listeners.add(listener);
  listener({ ...state });
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  const snapshot = { ...state };
  for (const l of listeners) l(snapshot);
}

function setState(patch: Partial<AgentState>): void {
  Object.assign(state, patch);
  emit();
}

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
  idleInterval = setInterval(() => {
    void idleTick();
  }, IDLE_INTERVAL_MS);
  patternMinerInterval = setInterval(() => {
    void runPatternMiner();
  }, IDLE_INTERVAL_MS * 6);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => {
      if (idleInterval) clearInterval(idleInterval);
      if (patternMinerInterval) clearInterval(patternMinerInterval);
    });
  }
  void initialSweep();
}

async function runPatternMiner(): Promise<void> {
  if (!projectRoot) return;
  if (state.status !== "idle") return;
  try {
    const { minePatterns } = await import("./patternMining");
    const result = await minePatterns({ projectRoot });
    if (result.recorded.length > 0) {
      setState({
        lastSummary: `Pattern miner found ${result.recorded.length} new patterns`,
      });
    }
  } catch (err) {
    console.warn("[engineering-profile] pattern miner failed:", err);
  }
}

export function stopLearningAgent(): void {
  if (idleInterval) clearInterval(idleInterval);
  if (patternMinerInterval) clearInterval(patternMinerInterval);
  idleInterval = null;
  patternMinerInterval = null;
  schedulerStarted = false;
  setState({ status: "idle" });
}

export function _resetAgentForTests(): void {
  if (idleInterval) clearInterval(idleInterval);
  if (patternMinerInterval) clearInterval(patternMinerInterval);
  idleInterval = null;
  patternMinerInterval = null;
  state.status = "idle";
  state.lastRefineAt = 0;
  state.signalsSinceLastRefine = 0;
  state.totalRefinements = 0;
  state.lastError = null;
  state.lastSummary = "Not yet started";
  state.startedAt = Date.now();
  schedulerStarted = false;
  projectRoot = null;
  turnHadRejection = false;
  emit();
}

export function setAgentProjectRoot(root: string | null): void {
  projectRoot = root;
  if (root) {
    setState({ lastSummary: `Watching ${root} for preference signals` });
  }
}

export function notifySignalRecorded(signal: Signal): void {
  if (signal.scope === "project" && signal.projectRoot) {
    setAgentProjectRoot(signal.projectRoot);
  }
  state.signalsSinceLastRefine++;
  emit();
}

export function notifyChatTurnFinished(
  turn?: import("./feedbackLoop").TurnSnapshot,
): void {
  void handleTurnFinished(turn);
}

async function handleTurnFinished(
  turn?: import("./feedbackLoop").TurnSnapshot,
): Promise<void> {
  if (turn) {
    await runFeedbackForTurn(turn);
  }
  // IMPORTANT: No automatic refinement on every agent turn.
  // Per user preference, refinements (the LLM extraction + merge step) are
  // driven only by new user-sent chat messages (see notifyUserMessageSent).
  // This prevents over-calling the costly extractor LLM on every turn/finish.
  // Feedback/RL (accept/reject signals) still runs on turns as it's cheap.
  // Accumulated signals from feedback or other sources will be processed
  // on the *next* user message.
}

async function runFeedbackForTurn(
  turn: import("./feedbackLoop").TurnSnapshot,
): Promise<void> {
  const root = turn.projectRoot ?? projectRoot ?? getAnchoredProjectRoot();
  try {
    const { scoreAlignment, emitAlignmentSignals, recordTurnAcceptance } =
      await import("./feedbackLoop");
    if (root) {
      const profile = await storage.getProfile("project", root);
      if (profile) {
        const scores = scoreAlignment(turn, profile);
        let hadViolations = false;
        if (scores.length > 0) {
          const emitted = await emitAlignmentSignals(
            scores,
            root,
            turn.sessionId,
          );
          if (emitted.length > 0) {
            state.signalsSinceLastRefine += emitted.length;
            emit();
          }
          hadViolations = scores.some((s) => s.alignment === "violated");
        }
        if (!turnHadRejection && !hadViolations) {
          const accepted = await recordTurnAcceptance(
            root,
            turn.sessionId,
            profile,
          );
          if (accepted.length > 0) {
            state.signalsSinceLastRefine += accepted.length;
            emit();
          }
        }
      }
    }
  } catch (err) {
    console.warn("[engineering-profile] turn feedback failed:", err);
  } finally {
    turnHadRejection = false;
  }
}

export function notifyToolRejection(toolName: string, reason: string): void {
  turnHadRejection = true;
  void observeUserMessage({
    text: `Don't use ${toolName} that way: ${reason}`,
    projectRoot,
  });
  // Note: we no longer auto-trigger refinement here. The rejection signal
  // is recorded by observeUserMessage (if it matches patterns). The actual
  // refinement pass (LLM merge) will happen on the next user chat message
  // (see notifyUserMessageSent) to control API cost.
}

export function notifyUserMessageSent(projectRootOverride?: string | null): void {
  if (projectRootOverride) {
    setAgentProjectRoot(projectRootOverride);
  }
  // This is the primary (and preferred) trigger for refinement.
  // Any time the user sends a chat message, we process accumulated signals
  // and intelligently run refinement if needed (subject to throttle,
  // pending signals count, in-flight lock, etc.).
  // This replaces per-turn "turn-finished" refinement to avoid overuse
  // and excessive LLM extractor costs.
  void maybeRefine("user-message");
}

export function notifyUserFileEdit(filePath: string, summary: string): void {
  const isProfileFile =
    filePath.endsWith("/.terax/profile.md") ||
    filePath.includes("/.terax/");  // catch any file inside .terax/ (root + domain split profiles) for self-write guards
  if (isProfileFile) {
    if (projectRoot) {
      void import("./storage").then(async (m) => {
        // Guard against our own writes...
        const lastWrite = (m as any).getLastProfileSelfWrite?.() ?? 0;
        if (Date.now() - lastWrite < 3000) {
          return;
        }
        await m.syncProfileFromDisk(projectRoot!);
      });
    }
    return;
  }
  const text = `User edited ${filePath}: ${summary}`;
  void observeUserMessage({ text, projectRoot });
  // We no longer immediately call maybeRefine here. observe may record a
  // preference signal if the edit text matches patterns. The refinement
  // (LLM pass) will be triggered on the next user-sent chat message.
}

async function idleTick(): Promise<void> {
  // Idle no longer triggers refinement passes.
  // Refinement (the LLM extractor + merge) is intentionally gated to
  // user-sent chat messages only (see notifyUserMessageSent + intelligence
  // guards inside maybeRefine) to avoid excessive API cost from the
  // continuous-learning extractor.
  if (state.signalsSinceLastRefine < IDLE_MIN_PENDING_SIGNALS) return;
  // Could do lightweight maintenance here in the future if needed,
  // but no auto-refine.
}

async function initialSweep(): Promise<void> {
  if (!projectRoot) return;
  try {
    const { isBootstrapped } = await import("./bootstrap");
    if (!(await isBootstrapped(projectRoot))) return;
    const [projectSignals, userSignals] = await Promise.all([
      storage.loadSignals("project", projectRoot),
      storage.loadSignals("user", null),
    ]);
    if (projectSignals.length > 0 || userSignals.length > 0) {
      await maybeRefine("initial-sweep");
    }
  } catch {
    /* storage may not be ready yet */
  }
}

async function maybeRefine(
  trigger:
    | "signal"
    | "user-message"
    | "rejection"
    | "user-edit"
    | "idle-tick"
    | "initial-sweep",
  _signal?: Signal,
): Promise<void> {
  const now = Date.now();
  if (state.status === "refining" || state.status === "writing") return;
  if (now - state.lastRefineAt < MIN_REFINEMENT_INTERVAL_MS) return;
  if (state.signalsSinceLastRefine === 0 && trigger !== "initial-sweep") return;
  await runRefinePass(trigger);
}

async function runRefinePass(trigger: string): Promise<void> {
  const scopes = await scopesNeedingRefine();
  if (scopes.length === 0) {
    setState({ status: "idle", lastSummary: "No pending signals to refine" });
    return;
  }
  const projectScope = scopes.find((s) => s.scope === "project");
  if (projectScope?.projectRoot) {
    const { isBootstrapped } = await import("./bootstrap");
    if (!(await isBootstrapped(projectScope.projectRoot))) {
      setState({ status: "idle", lastSummary: "Project not bootstrapped yet" });
      return;
    }
  }
  const lockScope: Scope = projectScope ? "project" : "user";
  const lockRoot = projectScope?.projectRoot ?? null;
  if (!acquireRefineLock(lockScope, lockRoot)) return;
  setState({ status: "observing", lastSummary: `Triggered by ${trigger}` });
  const t0 = Date.now();
  const job = (async () => {
    const deps = makeExtractorDeps();
    setState({
      status: "refining",
      lastSummary: "Refining profile (LLM pass)",
    });
    const results: RefineResult[] = [];
    for (const target of scopes) {
      results.push(
        await refineProfile(deps, {
          scope: target.scope,
          projectRoot: target.projectRoot,
          note: `auto-refine ${target.scope} (${trigger})`,
        }),
      );
    }
    const last = results[results.length - 1]!;
    setState({ status: "writing", lastSummary: "Writing profile.md" });
    state.signalsSinceLastRefine = 0;
    state.lastRefineAt = Date.now();
    state.totalRefinements++;
    setState({
      status: "idle",
      lastSummary: `Refined ${last.added.length} added, ${last.removed.length} removed, ${last.modified.length} modified in ${Date.now() - t0}ms`,
      lastError: null,
    });
  })();
  markRefineInFlight(lockScope, lockRoot, job);
  try {
    await job;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setState({ status: "error", lastError: msg, lastSummary: `Error: ${msg}` });
  }
}

async function scopesNeedingRefine(): Promise<
  { scope: Scope; projectRoot: string | null }[]
> {
  const out: { scope: Scope; projectRoot: string | null }[] = [];
  const activeRoot = projectRoot ?? getAnchoredProjectRoot();
  const userSignals = await storage.loadSignals("user", null);
  const projectSignals = activeRoot
    ? await storage.loadSignals("project", activeRoot)
    : [];
  if (userSignals.length > 0) {
    out.push({ scope: "user", projectRoot: null });
  }
  if (
    activeRoot &&
    (projectSignals.length > 0 || state.signalsSinceLastRefine > 0)
  ) {
    out.push({ scope: "project", projectRoot: activeRoot });
  }
  if (out.length === 0 && state.signalsSinceLastRefine > 0) {
    out.push({
      scope: activeRoot ? "project" : "user",
      projectRoot: activeRoot ?? null,
    });
  }
  return out;
}

export async function forceRefine(
  scope: Scope,
  projectRootOverride: string | null,
): Promise<void> {
  const root = projectRootOverride ?? projectRoot;
  if (scope === "project" && !root) return;
  const deps = makeExtractorDeps();
  await refineProfile(deps, {
    scope,
    projectRoot: scope === "project" ? root : null,
    note: "forced by user",
  });
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
  if (scope === "project" && !root) return null;
  const deps = makeExtractorDeps();
  const result = await refineProfile(deps, {
    scope,
    projectRoot: scope === "project" ? root : null,
    note: "forced sync",
  });
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