import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forceAutoRefine, maybeAutoRefine } from "./autoRefine";

vi.mock("@/modules/ai/lib/agent", () => ({
  buildConfiguredLanguageModel: vi.fn(),
}));

vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      apiKeys: { openai: "sk-test", anthropic: "", google: "" },
      selectedModelId: "gpt-5.4-mini",
    }),
  },
}));

const inMemoryStorage = new Map<string, unknown>();

vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  const memory = {
    appendSignal: vi.fn(async (s: unknown) => {
      const list = (memory.signals as unknown[]) ?? [];
      list.push(s);
      memory.signals = list;
    }),
    getProfile: vi.fn(async () => null),
    saveProfile: vi.fn(async () => {}),
    appendSnapshot: vi.fn(async () => {}),
    loadSnapshots: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({
      provider: "openai",
      modelId: "gpt-5",
      minConfidence: 0.35,
      maxAgeMs: 180 * 24 * 60 * 60 * 1000,
      decayHalfLifeMs: 60 * 24 * 60 * 60 * 1000,
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
    signals: [] as unknown[],
  };
  return {
    ...actual,
    storage: memory,
    getCachedConfig: () => ({
      provider: "openai",
      modelId: "gpt-5",
      minConfidence: 0.35,
      maxAgeMs: 180 * 24 * 60 * 60 * 1000,
      decayHalfLifeMs: 60 * 24 * 60 * 60 * 1000,
      promotionThreshold: 0.7,
      demotionThreshold: 0.25,
      maxPreferences: 240,
      splitMinPreferences: 5,
      splitMinAverageConfidence: 0.6,
      splitMinShare: 0.25,
    }),
  };
});

vi.mock("./refinement", async () => {
  const actual =
    await vi.importActual<typeof import("./refinement")>("./refinement");
  return {
    ...actual,
    refineProfile: vi.fn(async () => ({
      profile: {
        id: "p1",
        scope: "user",
        projectRoot: null,
        generatedAt: 0,
        summary: "",
        preferences: [],
        domains: {},
      },
      snapshot: {
        id: "s1",
        scope: "user",
        projectRoot: null,
        createdAt: 0,
        reason: "refine",
        profile: {} as never,
        changes: [],
        note: null,
      },
      added: [],
      removed: [],
      modified: [],
      dropped: [],
    })),
  };
});

describe("maybeAutoRefine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inMemoryStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns silently when no project root and no signals", async () => {
    await expect(
      maybeAutoRefine({ projectRoot: null }),
    ).resolves.toBeUndefined();
  });

  it("throttles back-to-back calls within the min interval", async () => {
    const { refineProfile } = await import("./refinement");
    const calls: number[] = [];
    vi.mocked(refineProfile).mockImplementation(async () => {
      calls.push(Date.now());
      return {
        profile: {} as never,
        snapshot: {} as never,
        added: [],
        removed: [],
        modified: [],
        dropped: [],
      };
    });
    await forceAutoRefine("user", null);
    await maybeAutoRefine({ projectRoot: null, minIntervalMs: 60_000 });
    expect(calls.length).toBe(1);
  });

  it("forceAutoRefine bypasses the throttle", async () => {
    const { refineProfile } = await import("./refinement");
    let calls = 0;
    vi.mocked(refineProfile).mockImplementation(async () => {
      calls++;
      return {
        profile: {} as never,
        snapshot: {} as never,
        added: [],
        removed: [],
        modified: [],
        dropped: [],
      };
    });
    await forceAutoRefine("user", null);
    await forceAutoRefine("user", null);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
