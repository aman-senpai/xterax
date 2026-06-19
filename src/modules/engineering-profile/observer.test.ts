import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appendSignalMock, loadSignalsMock, generateObjectMock } = vi.hoisted(
  () => ({
    appendSignalMock: vi.fn(async (_s: unknown) => {}),
    loadSignalsMock: vi.fn(async () => []),
    generateObjectMock: vi.fn(),
  }),
);

vi.mock("ai", () => ({
  generateObject: generateObjectMock,
}));

vi.mock("./autoRefine", () => ({
  makeExtractorDeps: () => ({
    getConfig: () => ({
      provider: "openai",
      thinkingLevel: "off",
      minConfidence: 0.35,
    }),
    getKeys: () => ({}),
    getModelId: () => "openai:gpt-4o-mini",
    getLocalConfig: () => undefined,
  }),
}));

vi.mock("@/modules/ai/lib/agent", () => ({
  buildConfiguredLanguageModel: vi.fn(async () => ({})),
}));

vi.mock("@/modules/ai/store/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      selectedModelId: "deepseek-v4-flash",
      apiKeys: { deepseek: "sk-test" },
    }),
  },
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      profileProvider: "openai",
      profileModelId: "",
      defaultModelId: "gpt-5.4-mini",
      customEndpoints: [],
    }),
  },
}));

vi.mock("./storage", async () => {
  const actual = await vi.importActual<typeof import("./storage")>("./storage");
  return {
    ...actual,
    storage: {
      ...actual.storage,
      appendSignal: appendSignalMock,
      loadSignals: loadSignalsMock,
    },
  };
});

import {
  observeUserMessage,
  resetObservationStateForTests,
} from "./observer";

function mockIntent(result: {
  hasStablePreference: boolean;
  preference?: string;
  category?: string;
  isRejection?: boolean;
  evidence?: string;
}) {
  generateObjectMock.mockResolvedValueOnce({ object: result });
}

describe("observeUserMessage — LLM intent capture", () => {
  beforeEach(() => {
    resetObservationStateForTests();
    generateObjectMock.mockReset();
    appendSignalMock.mockClear();
    loadSignalsMock.mockClear();
  });

  afterEach(() => {
    resetObservationStateForTests();
  });

  it("records stable preferences from LLM classification", async () => {
    mockIntent({
      hasStablePreference: true,
      preference: "Prefer clean, readable code with small focused functions",
      category: "general",
      evidence: "I like clean code",
    });
    const result = await observeUserMessage({
      text: "I prefer using TypeScript over JavaScript for new projects",
      projectRoot: null,
      force: true,
    });
    expect(result.recorded.length).toBe(1);
    expect(appendSignalMock).toHaveBeenCalledTimes(1);
  });

  it("detects Hindi taste statements via LLM", async () => {
    mockIntent({
      hasStablePreference: true,
      preference: "Prefer clean, readable code",
      category: "general",
      evidence: "Mujhe clean code pasand hai",
    });
    const result = await observeUserMessage({
      text: "Mujhe clean code pasand hai",
      projectRoot: "/Users/senpai/Developer/terax-ai",
      force: true,
    });
    expect(result.recorded.length).toBe(1);
    expect(result.recorded[0]?.preference).toContain("clean");
  });

  it("does NOT record when LLM returns no stable preference", async () => {
    mockIntent({ hasStablePreference: false });
    const result = await observeUserMessage({
      text: "ok thanks",
      projectRoot: null,
      force: true,
    });
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toContain("no-preference");
  });

  it("does NOT record one-off task requests when LLM declines", async () => {
    mockIntent({ hasStablePreference: false });
    const result = await observeUserMessage({
      text: "Please fix the bug in this file",
      projectRoot: null,
      force: true,
    });
    expect(result.recorded).toHaveLength(0);
  });

  it("records rejections when LLM marks isRejection", async () => {
    mockIntent({
      hasStablePreference: true,
      preference: "Do not use Redux",
      category: "frontend",
      isRejection: true,
    });
    const result = await observeUserMessage({
      text: "Don't use Redux in this project",
      projectRoot: null,
      force: true,
    });
    expect(result.recorded.length).toBe(1);
    expect(result.recorded[0]?.source).toBe("rejected-change");
  });

  it("skips re-observing the same message fingerprint", async () => {
    mockIntent({
      hasStablePreference: true,
      preference: "Prefer TypeScript",
      category: "frontend",
    });
    await observeUserMessage({
      text: "Always use TypeScript",
      projectRoot: "/proj",
    });
    const second = await observeUserMessage({
      text: "Always use TypeScript",
      projectRoot: "/proj",
    });
    expect(second.skipped).toContain("already-observed");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it("does not record raw recurring text after LLM already classified the message", async () => {
    mockIntent({
      hasStablePreference: true,
      preference: "I prefer clean code",
      category: "code-quality",
    });
    const text = "Mujhe clean code pasand hai";
    const root = "/proj";
    await observeUserMessage({ text, projectRoot: root });
    await observeUserMessage({ text, projectRoot: root });
    const third = await observeUserMessage({ text, projectRoot: root });
    expect(third.recorded).toHaveLength(0);
    expect(third.skipped).toContain("already-observed");
    expect(appendSignalMock).toHaveBeenCalledTimes(1);
  });

  it("ignores synthetic fs-watcher edit messages", async () => {
    const result = await observeUserMessage({
      text: "User edited /proj/.xterax: user edited file",
      projectRoot: "/proj",
      force: true,
    });
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toContain("synthetic-edit");
    expect(generateObjectMock).not.toHaveBeenCalled();
  });

  it("records recurring preference after repeated identical messages", async () => {
    generateObjectMock.mockResolvedValue({
      object: { hasStablePreference: false },
    });
    const text = "Mujhe clean code pasand hai";
    const root = "/proj";
    for (let i = 0; i < 2; i++) {
      await observeUserMessage({
        text,
        projectRoot: root,
        force: true,
      });
    }
    const third = await observeUserMessage({
      text,
      projectRoot: root,
      force: true,
    });
    expect(third.recorded.length).toBe(1);
    expect(third.recorded[0]?.source).toBe("recurring-request");
  });

  it("falls back to recurring when LLM is unavailable", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("no key"));
    loadSignalsMock.mockResolvedValueOnce([]);
    const result = await observeUserMessage({
      text: "Always use server components",
      projectRoot: null,
      force: true,
    });
    expect(result.skipped).toContain("llm-unavailable");
    expect(result.recorded).toHaveLength(0);
  });
});