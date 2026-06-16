import { useEffect, useState, type ReactElement } from "react";
import type { AgentState } from "./learningAgent";

const STATUS_LABEL: Record<AgentState["status"], string> = {
  idle: "idle",
  observing: "observing",
  refining: "refining",
  writing: "writing",
  error: "error",
};

const STATUS_COLOR: Record<AgentState["status"], string> = {
  idle: "text-muted-foreground",
  observing: "text-blue-500",
  refining: "text-amber-500",
  writing: "text-amber-500",
  error: "text-red-500",
};

const NOOP_STATE: AgentState = {
  status: "idle",
  lastRefineAt: 0,
  signalsSinceLastRefine: 0,
  totalRefinements: 0,
  lastError: null,
  lastSummary: "loading…",
  startedAt: 0,
};

/**
 * Tiny status pill for the bottom status bar. Shows what the autonomous
 * continuous-learning agent is doing in the background. The agent module
 * is loaded lazily so the StatusBar does not pull the AI SDK into the
 * startup graph.
 */
export function LearningAgentPill(): ReactElement {
  const [state, setState] = useState<AgentState>(NOOP_STATE);
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void import("./learningAgent").then((m) => {
      if (cancelled) return;
      setState(m.getAgentState());
      unsub = m.subscribeAgent(setState);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);
  const label = STATUS_LABEL[state.status];
  const color = STATUS_COLOR[state.status];
  const tooltip = `${state.lastSummary} • ${state.totalRefinements} refinements since startup`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] tabular-nums ${color}`}
      title={tooltip}
      data-state={state.status}
    >
      <span
        className={`inline-block size-1.5 rounded-full ${
          state.status === "idle" ? "bg-muted-foreground/40" : "bg-current animate-pulse"
        }`}
      />
      <span>learn:{label}</span>
      {state.signalsSinceLastRefine > 0 ? (
        <span className="text-muted-foreground">+{state.signalsSinceLastRefine}</span>
      ) : null}
    </span>
  );
}
