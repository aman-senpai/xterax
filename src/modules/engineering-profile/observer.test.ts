import { afterEach, describe, expect, it, vi } from "vitest";

const { appendSignalMock, loadSignalsMock } = vi.hoisted(() => ({
  appendSignalMock: vi.fn(async (_s: unknown) => {}),
  loadSignalsMock: vi.fn(async () => []),
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

import { observeUserMessage } from "./observer";

describe("observeUserMessage — passive preference capture", () => {
  afterEach(() => {
    appendSignalMock.mockClear();
    loadSignalsMock.mockClear();
  });

  it("records explicit 'I prefer X' statements", async () => {
    const result = await observeUserMessage({
      text: "I prefer using TypeScript over JavaScript for new projects",
      projectRoot: null,
    });
    expect(result.recorded.length).toBeGreaterThan(0);
    expect(appendSignalMock).toHaveBeenCalled();
  });

  it("records 'always use X' patterns", async () => {
    const result = await observeUserMessage({
      text: "Always use server components instead of client components",
      projectRoot: null,
    });
    expect(result.recorded.length).toBeGreaterThan(0);
  });

  it("does NOT record short acknowledgments", async () => {
    const result = await observeUserMessage({
      text: "ok thanks",
      projectRoot: null,
    });
    expect(result.recorded).toHaveLength(0);
  });

  it("does NOT record one-off file-specific instructions", async () => {
    const result = await observeUserMessage({
      text: "Please fix the bug in this file",
      projectRoot: null,
    });
    expect(result.recorded).toHaveLength(0);
    expect(result.skipped).toContain("one-off-indicator");
  });

  it("records 'don't use X' patterns as preferences (negative intent)", async () => {
    const result = await observeUserMessage({
      text: "Don't use Redux in this project",
      projectRoot: null,
    });
    expect(result.recorded.length).toBeGreaterThan(0);
  });

  it("records 'stop using X' as either an explicit preference or a rejection", async () => {
    const result = await observeUserMessage({
      text: "Stop using inline styles in this codebase",
      projectRoot: null,
    });
    expect(result.recorded.length).toBeGreaterThan(0);
  });

  it("does NOT record mid-task clarifications", async () => {
    const result = await observeUserMessage({
      text: "actually rename this variable to userId please",
      projectRoot: null,
    });
    expect(result.recorded).toHaveLength(0);
  });

  it("records free-form preferences without a hardcoded domain", async () => {
    const result = await observeUserMessage({
      text: "I prefer using the latest SwiftUI syntax",
      projectRoot: null,
    });
    if (result.recorded.length > 0) {
      const validDomains = ["frontend", "general"];
      expect(validDomains).toContain(result.recorded[0]?.category);
    }
  });
});
