/**
 * Structured loop outcomes for agent pipelines.
 *
 * Break decisions use machine signals only — never natural-language heuristics.
 *
 * Canonical agent line (last occurrence wins):
 *   PIPELINE_OUTCOME: pass | fail | continue
 *
 * Aliases (same semantics):
 *   PIPELINE_BREAK: pass | fail | done | ok | continue
 *   <<<PIPELINE_OUTCOME:pass>>>
 *
 * Semantics:
 *   pass      — verification / goal met; break when `break if pass`
 *   fail      — checks failed or step failed; break when `break if fail`
 *   continue  — explicit "not done yet"; never breaks pass/fail conditions
 *
 * Body resolution (after one loop iteration):
 *   1. User abort on any step → aborted
 *   2. Last explicit signal in the body (scan reverse) wins
 *   3. Else if any step errored → synthetic fail
 *   4. Else → unknown (no break for pass/fail)
 */

import type { BreakCond } from "./pipelineDsl";

/** Machine-readable iteration signal. */
export type PipelineSignal = "pass" | "fail" | "continue";

/** Resolved outcome for one loop body execution. */
export type BodyOutcomeKind =
  | "aborted"
  | "pass"
  | "fail"
  | "continue"
  | "unknown";

export type BodyStepSnapshot = {
  handle: string;
  status: "done" | "error" | "aborted";
  summary: string;
};

export type BodyOutcome = {
  kind: BodyOutcomeKind;
  /** Handle of the step that provided the signal, if any. */
  sourceHandle: string | null;
  /** How the outcome was derived. */
  reason:
    | "user_abort"
    | "explicit_signal"
    | "step_error"
    | "no_signal"
    | "empty_body";
  /** Last matched signal line text, if any. */
  signalLine: string | null;
};

/**
 * Match structured outcome lines. Global — last match wins when scanning.
 * Allow optional trailing punctuation / angle brackets.
 */
const SIGNAL_LINE_RE =
  /(?:PIPELINE_(?:OUTCOME|BREAK)|<<<\s*PIPELINE_OUTCOME)\s*:\s*(pass|fail|done|ok|continue)\b\s*(?:>{0,3})?/gi;

export function normalizeSignalToken(raw: string): PipelineSignal | null {
  const v = raw.trim().toLowerCase();
  if (v === "pass" || v === "ok" || v === "done") return "pass";
  if (v === "fail") return "fail";
  if (v === "continue") return "continue";
  return null;
}

/**
 * Extract the last structured pipeline signal from agent text.
 * Returns null when no machine line is present (NL prose is ignored).
 */
export function extractPipelineSignal(text: string): {
  signal: PipelineSignal;
  line: string;
} | null {
  if (!text) return null;
  let last: { signal: PipelineSignal; line: string } | null = null;
  SIGNAL_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SIGNAL_LINE_RE.exec(text)) !== null) {
    const signal = normalizeSignalToken(m[1] ?? "");
    if (!signal) continue;
    last = { signal, line: m[0].trim() };
  }
  return last;
}

/**
 * Resolve one full loop-body run into a single structured outcome.
 * Scans steps reverse so the last explicit signal (typically verification) wins.
 */
export function resolveBodyOutcome(
  steps: readonly BodyStepSnapshot[],
): BodyOutcome {
  if (steps.length === 0) {
    return {
      kind: "unknown",
      sourceHandle: null,
      reason: "empty_body",
      signalLine: null,
    };
  }

  for (const s of steps) {
    if (s.status === "aborted") {
      return {
        kind: "aborted",
        sourceHandle: s.handle,
        reason: "user_abort",
        signalLine: null,
      };
    }
  }

  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (!s) continue;
    const found = extractPipelineSignal(s.summary);
    if (!found) continue;
    return {
      kind: found.signal,
      sourceHandle: s.handle,
      reason: "explicit_signal",
      signalLine: found.line,
    };
  }

  const errored = steps.find((s) => s.status === "error");
  if (errored) {
    return {
      kind: "fail",
      sourceHandle: errored.handle,
      reason: "step_error",
      signalLine: null,
    };
  }

  return {
    kind: "unknown",
    sourceHandle: null,
    reason: "no_signal",
    signalLine: null,
  };
}

/**
 * Whether the loop should exit after this body run.
 * Pure: only structured BodyOutcome + DSL break condition.
 *
 * | breakWhen | breaks when        |
 * |-----------|--------------------|
 * | null      | never (run to max) |
 * | never     | never              |
 * | always    | after every body   |
 * | pass/done | outcome pass       |
 * | fail      | outcome fail       |
 * | ok        | same as pass (normalized at parse) |
 */
export function shouldBreakLoop(
  breakWhen: BreakCond | null,
  outcome: BodyOutcome,
): boolean {
  if (!breakWhen || breakWhen === "never") return false;
  if (breakWhen === "always") return true;
  // Aborts are handled by the executor, not as break-if-pass/fail.
  if (outcome.kind === "aborted") return false;

  if (breakWhen === "pass" || breakWhen === "done") {
    return outcome.kind === "pass";
  }
  if (breakWhen === "fail") {
    return outcome.kind === "fail";
  }
  return false;
}

/** Human-readable note for UI after a loop iteration decision. */
export function formatLoopBreakNote(opts: {
  loopId: string;
  iter: number;
  max: number;
  breakWhen: BreakCond | null;
  outcome: BodyOutcome;
  broke: boolean;
  atMax: boolean;
}): string {
  const { loopId, iter, max, breakWhen, outcome, broke, atMax } = opts;
  const src = outcome.sourceHandle ? ` via @${outcome.sourceHandle}` : "";
  const sig = outcome.signalLine ? ` (${outcome.signalLine})` : "";

  if (broke) {
    if (breakWhen === "always") {
      return `Broke ${loopId} after iter ${iter}/${max} (break if always)`;
    }
    return `Broke ${loopId} after iter ${iter}/${max} (break if ${breakWhen}; outcome ${outcome.kind}${src}${sig})`;
  }
  if (atMax) {
    return `Finished ${loopId} at max ${max} iterations (last outcome: ${outcome.kind}${src})`;
  }
  return `${loopId} iter ${iter}/${max}: ${outcome.kind}${src} — continue`;
}

/**
 * Instruction block injected into every agent prompt while inside a loop.
 * Requires a machine line so break evaluation is deterministic.
 */
export function loopOutcomeInstruction(opts: {
  loopId: string;
  iter: number;
  max: number;
  breakWhen: BreakCond | null;
  isVerifier: boolean;
}): string {
  const { loopId, iter, max, breakWhen, isVerifier } = opts;
  const lines = [
    `## Loop control (${loopId}, iteration ${iter} of ${max})`,
    "This step is inside an agentic loop. Break decisions use structured signals only.",
    "End your final message with exactly one of these lines (last occurrence wins):",
    "",
    "PIPELINE_OUTCOME: pass",
    "PIPELINE_OUTCOME: fail",
    "PIPELINE_OUTCOME: continue",
    "",
    "- pass — goal met / checks green; loop may exit on `break if pass`",
    "- fail — checks failed or work is wrong; loop may exit on `break if fail`",
    "- continue — not done yet; loop will not treat this as pass or fail",
  ];
  if (breakWhen) {
    lines.push("", `This loop uses: break if ${breakWhen}`);
  }
  if (isVerifier) {
    lines.push(
      "",
      "You are the verification step. You MUST emit PIPELINE_OUTCOME after running checks.",
      "Green checks → PIPELINE_OUTCOME: pass. Any failure → PIPELINE_OUTCOME: fail.",
    );
  } else {
    lines.push(
      "",
      "If you only implement or analyze, prefer PIPELINE_OUTCOME: continue unless you fully verified success/failure yourself.",
    );
  }
  return lines.join("\n");
}

export function isVerifierHandle(handle: string): boolean {
  return (
    handle === "verification" || handle === "verify" || handle === "verifier"
  );
}

/**
 * @deprecated Prefer resolveBodyOutcome + shouldBreakLoop.
 * Kept for call sites that only have a single summary string; uses structured
 * signals only (no NL heuristics).
 */
export function evaluateBreak(
  cond: BreakCond | null,
  lastSummary: string,
): boolean {
  const outcome = resolveBodyOutcome([
    { handle: "_", status: "done", summary: lastSummary },
  ]);
  return shouldBreakLoop(cond, outcome);
}
