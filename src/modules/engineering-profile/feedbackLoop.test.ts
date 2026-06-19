import { beforeEach, describe, expect, it, vi } from "vitest";

const { recordAcceptedChangeMock } = vi.hoisted(() => ({
  recordAcceptedChangeMock: vi.fn(async () => ({
    accepted: true,
    signal: {
      id: "sig-1",
      timestamp: 0,
      source: "accepted-change" as const,
      scope: "project" as const,
      projectRoot: "/test",
      category: "general",
      preference: "Use TypeScript",
      evidence: "",
      weight: 1,
    },
  })),
}));

vi.mock("./signals", () => ({
  recordRejectedChange: vi.fn(),
  recordAcceptedChange: recordAcceptedChangeMock,
}));

import { recordTurnAcceptance, scoreAlignment, type TurnSnapshot } from "./feedbackLoop";
import type { Preference, Profile } from "./types";

function pref(over: Partial<Preference>): Preference {
  return {
    id: over.id ?? "p1",
    canonicalRuleId: over.canonicalRuleId ?? `${over.category ?? "frontend"}_prefer-typescript`,
    category: over.category ?? "frontend",
    preference: over.preference ?? "Prefer TypeScript",
    confidence: over.confidence ?? 0.7,
    evidenceCount: over.evidenceCount ?? 1,
    firstObservedAt: over.firstObservedAt ?? 0,
    lastObservedAt: over.lastObservedAt ?? 0,
    signalIds: over.signalIds ?? [],
    supportingSources: over.supportingSources ?? [],
    scope: over.scope ?? "user",
    projectRoot: over.projectRoot ?? null,
    reinforcement: over.reinforcement ?? 1,
    pinned: over.pinned ?? false,
    supersededBy: over.supersededBy ?? null,
  };
}

function profileOf(prefs: Preference[]): Profile {
  return {
    id: "p",
    scope: "user",
    projectRoot: null,
    generatedAt: 0,
    summary: "",
    preferences: prefs,
    domains: {},
  };
}

function turnOf(
  text: string,
  toolCalls: { toolName: string; input: Record<string, unknown> }[] = [],
): TurnSnapshot {
  return {
    sessionId: "s1",
    projectRoot: null,
    text,
    toolCalls,
    timestamp: 0,
  };
}

describe("scoreAlignment — RL feedback loop", () => {
  it("returns honored when a positive preference is present in the turn", () => {
    const p = pref({
      preference: "Use TypeScript for new projects",
      confidence: 0.8,
    });
    const scores = scoreAlignment(
      turnOf("Writing a TypeScript file"),
      profileOf([p]),
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]?.alignment).toBe("honored");
  });

  it("returns violated when a negative preference is present in the turn", () => {
    const p = pref({ preference: "Don't use Redux", confidence: 0.8 });
    const scores = scoreAlignment(
      turnOf("I added Redux to the project"),
      profileOf([p]),
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]?.alignment).toBe("violated");
  });

  it("returns honored when a negative preference is NOT present", () => {
    const p = pref({ preference: "Don't use Redux", confidence: 0.8 });
    const scores = scoreAlignment(
      turnOf("I'm using Zustand instead"),
      profileOf([p]),
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]?.alignment).toBe("honored");
  });

  it("returns neutral for low-confidence preferences (below threshold)", () => {
    const p = pref({ preference: "Use TypeScript", confidence: 0.3 });
    const scores = scoreAlignment(turnOf("Hello world"), profileOf([p]));
    expect(scores).toHaveLength(0);
  });

  it("skips pinned preferences (they don't move with feedback)", () => {
    const p = pref({
      preference: "Don't use Redux",
      confidence: 0.9,
      pinned: true,
    });
    const scores = scoreAlignment(turnOf("Redux is great"), profileOf([p]));
    expect(scores).toHaveLength(0);
  });

  it("detects keywords in tool call inputs", () => {
    const p = pref({
      preference: "Prefer Vitest for unit tests",
      confidence: 0.8,
    });
    const scores = scoreAlignment(
      turnOf("", [
        { toolName: "bash_run", input: { command: "npx vitest run" } },
      ]),
      profileOf([p]),
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]?.alignment).toBe("honored");
  });

  it("does not match when keyword is not in the turn", () => {
    const p = pref({ preference: "Use TypeScript", confidence: 0.8 });
    const scores = scoreAlignment(turnOf("Hello"), profileOf([p]));
    expect(scores).toHaveLength(0);
  });

  it("returns neutral for unrecognizable preferences", () => {
    const p = pref({
      preference: "Generic guidance with no specific token xyz123",
      confidence: 0.8,
    });
    const scores = scoreAlignment(turnOf("Doing stuff"), profileOf([p]));
    expect(scores).toHaveLength(0);
  });
});

describe("recordTurnAcceptance", () => {
  beforeEach(() => {
    recordAcceptedChangeMock.mockClear();
  });

  it("records accepted-change signals for top high-confidence preferences", async () => {
    const profile = profileOf([
      pref({ preference: "Use TypeScript", confidence: 0.9 }),
      pref({ id: "p2", preference: "Use Vitest", confidence: 0.8 }),
      pref({ id: "p3", preference: "Low", confidence: 0.4 }),
    ]);
    const signals = await recordTurnAcceptance("/test", "session-1", profile);
    expect(signals).toHaveLength(2);
    expect(recordAcceptedChangeMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty when profile has no preferences", async () => {
    const signals = await recordTurnAcceptance("/test", "session-1", profileOf([]));
    expect(signals).toHaveLength(0);
  });
});
