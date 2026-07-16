import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({
  native: {
    deleteEntry: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  },
}));

import { native } from "../lib/native";
import { useMutationStore, type FileMutation } from "./mutationStore";

const sessionId = "sess-1";

type RecordInput = Omit<FileMutation, "id" | "at" | "messageId">;

function record(overrides: Partial<RecordInput> = {}) {
  useMutationStore.getState().record({
    sessionId,
    kind: "write_file",
    path: "/tmp/a.ts",
    originalContent: "old",
    newContent: "new",
    isNewFile: false,
    turnId: "turn-1",
    ...overrides,
  });
}

beforeEach(() => {
  useMutationStore.setState({ bySession: {} });
  vi.mocked(native.deleteEntry).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(native.writeFile).mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => {
  useMutationStore.setState({ bySession: {} });
});

describe("mutationStore", () => {
  it("assignMessageId maps mutations with matching turnId", () => {
    record({ path: "/tmp/a.ts", turnId: "turn-1" });
    record({ path: "/tmp/b.ts", turnId: "turn-2" });
    useMutationStore.getState().assignMessageId(sessionId, "turn-1", "msg-1");
    const list = useMutationStore.getState().getForSession(sessionId);
    expect(list.find((m) => m.path === "/tmp/a.ts")?.messageId).toBe("msg-1");
    expect(list.find((m) => m.path === "/tmp/b.ts")?.messageId).toBeNull();
  });

  it("restore filters by messageId and only drops successful entries", async () => {
    record({ path: "/tmp/ok.ts", turnId: "turn-1" });
    record({ path: "/tmp/fail.ts", turnId: "turn-1" });
    useMutationStore.getState().assignMessageId(sessionId, "turn-1", "msg-1");
    // Unrelated turn stays put.
    record({ path: "/tmp/other.ts", turnId: "turn-2" });
    useMutationStore.getState().assignMessageId(sessionId, "turn-2", "msg-2");

    vi.mocked(native.writeFile).mockImplementation(async (path: string) => {
      if (path === "/tmp/fail.ts") throw new Error("disk full");
    });

    const result = await useMutationStore.getState().restore(sessionId, "msg-1");
    expect(result).toEqual({ ok: 1, failed: 1 });

    const remaining = useMutationStore.getState().getForSession(sessionId);
    expect(remaining.map((m) => m.path).sort()).toEqual([
      "/tmp/fail.ts",
      "/tmp/other.ts",
    ]);
  });

  it("restore without messageId undoes the whole session", async () => {
    record({ path: "/tmp/a.ts", turnId: "t1" });
    record({
      path: "/tmp/new.ts",
      turnId: "t1",
      isNewFile: true,
      originalContent: "",
      newContent: "x",
    });
    useMutationStore.getState().assignMessageId(sessionId, "t1", "msg-1");

    const result = await useMutationStore.getState().restore(sessionId);
    expect(result).toEqual({ ok: 2, failed: 0 });
    expect(native.writeFile).toHaveBeenCalledWith("/tmp/a.ts", "old");
    expect(native.deleteEntry).toHaveBeenCalledWith("/tmp/new.ts");
    expect(useMutationStore.getState().getForSession(sessionId)).toEqual([]);
  });
});
