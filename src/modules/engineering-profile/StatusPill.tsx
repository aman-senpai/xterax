import { useEffect, useState, type ReactElement } from "react";
import type { AgentState } from "./learningAgent";
import { displayAgentPill, pillColorClass } from "./statusDisplay";

const NOOP_STATE: AgentState = {
  status: "idle",
  lastRefineAt: 0,
  signalsSinceLastRefine: 0,
  totalRefinements: 0,
  lastError: null,
  lastSummary: "idle",
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
  const { label, color } = displayAgentPill(state);
  const tooltip = [
    state.lastSummary,
    state.status === "error" && state.lastError ? state.lastError : null,
    `${state.totalRefinements} refinements since startup`,
  ]
    .filter(Boolean)
    .join(" • ");
  const isActive =
    state.status !== "idle" || state.signalsSinceLastRefine > 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] tabular-nums ${pillColorClass(color)}`}
      title={tooltip}
      data-state={state.status}
    >
      <span
        className={`inline-block size-1.5 rounded-full ${
          isActive ? "bg-current animate-pulse" : "bg-muted-foreground/40"
        }`}
      />
      <span>learn:{label}</span>
      {state.signalsSinceLastRefine > 0 ? (
        <span className="text-muted-foreground">
          +{state.signalsSinceLastRefine}
        </span>
      ) : null}
    </span>
  );
}