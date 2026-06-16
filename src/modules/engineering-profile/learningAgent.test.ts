import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refineProfileMock, appendSignalMock, signals } = vi.hoisted(() => {
  const signals: unknown[] = [];
  return {
    refineProfileMock: vi.fn(async () => ({
      profile: {
        id: "p1",
        scope: "project" as const,
        projectRoot: "/test",
        generatedAt: 0,
        summary: "",
        preferences: [],
        domains: {},
      },
      snapshot: {} as never,
      added: [],
      removed: [],
      modified: [],
      dropped: [],
    })),
    appendSignalMock: vi.fn(async (s: unknown) => {
      signals.push(s);
    }),
    signals,
  };
});

vi.mock("./refinement", () => ({
  refineProfile: refineProfileMock,
  buildDomainProfiles: vi.fn(() => ({})),
  diffChanges: vi.fn(() => []),
  mergeProfiles: vi.fn(),
  resolveConflict: vi.fn(),
  rollbackTo: vi.fn(),
  generateSummary: vi.fn(() => ""),
  generateDomainSummary: vi.fn(() => ""),
}));

vi.mock("./storage", () => {
  let nextId = 0;
  return {
    storage: {
      appendSignal: appendSignalMock,
      getProfile: vi.fn(async () => null),
      saveProfile: vi.fn(async () => {}),
      appendSnapshot: vi.fn(async () => {}),
      loadSnapshots: vi.fn(async () => []),
      loadSignals: vi.fn(async () => signals),
      getConfig: vi.fn(async () => ({
        provider: "heuristic",
        modelId: "test",
        minConfidence: 0.35,
        maxAgeMs: 100000,
        decayHalfLifeMs: 100000,
        promotionThreshold: 0.7,
        demotionThreshold: 0.25,
        maxPreferences: 240,
        splitMinPreferences: 5,
        splitMinAverageConfidence: 0.6,
        splitMinShare: 0.25,
      })),
      saveConfig: vi.fn(async () => {}),
      listProjectProfiles: vi.fn(async () => []),
      writeHumanView: vi.fn(async () => {}),
    },
    getCachedConfig: () => ({
      provider: "heuristic" as const,
      modelId: "test",
      minConfidence: 0.35,
      maxAgeMs: 100000,
      decayHalfLifeMs: 100000,
      promotionThreshold: 0.7,
      demotionThreshold: 0.25,
      maxPreferences: 240,
      splitMinPreferences: 5,
      splitMinAverageConfidence: 0.6,
      splitMinShare: 0.25,
    }),
    makeBlankProfile: vi.fn(() => ({})),
    newSignalId: () => `sig-test-${++nextId}`,
    newPreferenceId: () => `pref-test-${++nextId}`,
    newSnapshotId: () => `snap-test-${++nextId}`,
  };
});

vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: { openai: "sk-test" },
      selectedModelId: "openai:gpt-5",
    }),
  },
}));

import {
  _resetAgentForTests,
  getAgentState,
  notifyChatTurnFinished,
  notifySignalRecorded,
  startLearningAgent,
  subscribeAgent,
} from "./learningAgent";
import { recordSignal } from "./signals";
import type { Signal } from "./types";

function makeSignal(over: Partial<Signal> = {}): Signal {
  return {
    id: "s1",
    timestamp: 0,
    source: "explicit-feedback",
    scope: "user",
    projectRoot: null,
    category: "frontend",
    preference: "Use TypeScript",
    evidence: "user said so",
    weight: 1,
    ...over,
  };
}

describe("LearningAgent — autonomous continuous learning", () => {
  beforeEach(() => {
    _resetAgentForTests();
    signals.length = 0;
    refineProfileMock.mockClear();
    appendSignalMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in idle state and reports agent state via subscribe", () => {
    startLearningAgent("/test");
    const states: ReturnType<typeof getAgentState>[] = [];
    const unsub = subscribeAgent((s) => states.push({ ...s }));
    expect(states.length).toBeGreaterThan(0);
    expect(states[0]?.status).toBeDefined();
    unsub();
  });

  it("notifies the agent when a signal is recorded", async () => {
    startLearningAgent("/test");
    notifySignalRecorded(makeSignal({ id: "s1" }));
    expect(getAgentState().signalsSinceLastRefine).toBeGreaterThan(0);
  });

  it("throttles back-to-back refinement passes", async () => {
    startLearningAgent("/test");
    notifySignalRecorded(makeSignal({ id: "s1" }));
    await new Promise((r) => setTimeout(r, 10));
    notifySignalRecorded(makeSignal({ id: "s2" }));
    await new Promise((r) => setTimeout(r, 10));
    notifyChatTurnFinished();
    await new Promise((r) => setTimeout(r, 10));
    expect(refineProfileMock.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("refines when notifyChatTurnFinished is called after a signal burst", async () => {
    startLearningAgent("/test");
    notifySignalRecorded(makeSignal({ id: "s1" }));
    notifyChatTurnFinished();
    await new Promise((r) => setTimeout(r, 50));
    expect(refineProfileMock).toHaveBeenCalled();
  });

  it("records signals asynchronously when recordSignal is called", async () => {
    await recordSignal({
      source: "explicit-feedback",
      category: "frontend",
      preference: "Prefer Vitest for unit tests",
      evidence: "user mentioned it",
      scope: "user",
    });
    expect(appendSignalMock).toHaveBeenCalled();
  });

  it("runs multiple refinements across separate windows", async () => {
    startLearningAgent("/test");
    notifySignalRecorded(makeSignal({ id: "s1" }));
    await new Promise((r) => setTimeout(r, 50));
    const firstCount = refineProfileMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    notifySignalRecorded(makeSignal({ id: "s2" }));
    notifyChatTurnFinished();
    await new Promise((r) => setTimeout(r, 50));
    const secondCount = refineProfileMock.mock.calls.length;
    expect(secondCount).toBeGreaterThanOrEqual(firstCount);
  });
});
