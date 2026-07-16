import { afterEach, describe, expect, it } from "vitest";
import {
  __resetTurnsForTests,
  beginTurn,
  consumeFinishedTurn,
  getActiveTurnId,
} from "./currentTurn";

afterEach(() => {
  __resetTurnsForTests();
});

describe("currentTurn", () => {
  it("tracks active turn per session for tools", () => {
    const t1 = beginTurn("s1");
    expect(getActiveTurnId("s1")).toBe(t1);
    expect(getActiveTurnId("s2")).toBeNull();
  });

  it("consumeFinishedTurn returns active id when no next turn started", () => {
    const t1 = beginTurn("s1");
    expect(consumeFinishedTurn("s1")).toBe(t1);
    expect(getActiveTurnId("s1")).toBeNull();
    expect(consumeFinishedTurn("s1")).toBeNull();
  });

  it("parks previous turn when beginTurn races before consume", () => {
    const t1 = beginTurn("s1");
    const t2 = beginTurn("s1");
    expect(getActiveTurnId("s1")).toBe(t2);
    // Idle effect for turn 1 still sees t1 even though t2 is already active.
    expect(consumeFinishedTurn("s1")).toBe(t1);
    expect(getActiveTurnId("s1")).toBe(t2);
    expect(consumeFinishedTurn("s1")).toBe(t2);
    expect(getActiveTurnId("s1")).toBeNull();
  });

  it("isolates sessions", () => {
    const a = beginTurn("a");
    const b = beginTurn("b");
    expect(consumeFinishedTurn("a")).toBe(a);
    expect(getActiveTurnId("b")).toBe(b);
  });
});
