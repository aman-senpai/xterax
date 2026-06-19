import type { AgentState } from "./learningAgent";

export type PillDisplay = {
  label: string;
  color: "muted" | "pending" | "active" | "ready" | "error";
};

export function displayAgentPill(state: AgentState): PillDisplay {
  if (state.status === "error") {
    return { label: "error", color: "error" };
  }
  if (state.status === "observing") {
    return { label: "observing", color: "pending" };
  }
  if (state.status === "refining" || state.status === "writing") {
    return { label: state.status, color: "active" };
  }
  if (state.signalsSinceLastRefine > 0) {
    return { label: "pending", color: "pending" };
  }
  if (state.totalRefinements > 0) {
    return { label: "ready", color: "ready" };
  }
  return { label: "idle", color: "muted" };
}

const COLOR_CLASS: Record<PillDisplay["color"], string> = {
  muted: "text-muted-foreground",
  pending: "text-blue-500",
  active: "text-amber-500",
  ready: "text-emerald-500/70",
  error: "text-red-500",
};

export function pillColorClass(color: PillDisplay["color"]): string {
  return COLOR_CLASS[color];
}