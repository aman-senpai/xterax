import { describe, expect, it } from "vitest";
import type { AgentState } from "./learningAgent";
import { displayAgentPill } from "./statusDisplay";

const base: AgentState = {
  status: "idle",
  lastRefineAt: 0,
  signalsSinceLastRefine: 0,
  totalRefinements: 0,
  lastError: null,
  lastSummary: "idle",
  startedAt: 0,
};

describe("displayAgentPill", () => {
  it("shows idle before any signals or refinements", () => {
    expect(displayAgentPill(base)).toEqual({ label: "idle", color: "muted" });
  });

  it("shows pending with counter when signals are queued", () => {
    expect(
      displayAgentPill({ ...base, signalsSinceLastRefine: 2 }),
    ).toEqual({ label: "pending", color: "pending" });
  });

  it("shows ready after a successful refinement", () => {
    expect(
      displayAgentPill({ ...base, totalRefinements: 1 }),
    ).toEqual({ label: "ready", color: "ready" });
  });

  it("does not show ready label in red when lastError is stale but status is idle", () => {
    expect(
      displayAgentPill({
        ...base,
        totalRefinements: 1,
        lastError: "old failure",
      }),
    ).toEqual({ label: "ready", color: "ready" });
  });

  it("shows error only when status is error", () => {
    expect(
      displayAgentPill({
        ...base,
        status: "error",
        lastError: "No API key",
      }),
    ).toEqual({ label: "error", color: "error" });
  });
});