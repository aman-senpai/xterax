import { describe, expect, it } from "vitest";
import {
  countCompleted,
  hasActiveTodos,
  isTodosComplete,
  parseTodosInput,
  type Todo,
  todosFingerprint,
  validateTodos,
} from "./todos";

const sample = (
  overrides: Partial<Todo> & Pick<Todo, "id" | "title">,
): Todo => ({
  status: "pending",
  ...overrides,
});

describe("validateTodos", () => {
  it("rejects empty titles", () => {
    expect(
      validateTodos([sample({ id: "a", title: "  ", status: "pending" })]),
    ).toMatch(/empty/i);
  });

  it("allows at most one in_progress", () => {
    expect(
      validateTodos([
        sample({ id: "a", title: "A", status: "in_progress" }),
        sample({ id: "b", title: "B", status: "in_progress" }),
      ]),
    ).toMatch(/in_progress/);
  });

  it("accepts a valid list", () => {
    expect(
      validateTodos([
        sample({ id: "a", title: "A", status: "completed" }),
        sample({ id: "b", title: "B", status: "in_progress" }),
        sample({ id: "c", title: "C", status: "pending" }),
      ]),
    ).toBeNull();
  });
});

describe("hasActiveTodos / isTodosComplete", () => {
  it("empty list is neither active nor complete", () => {
    expect(hasActiveTodos([])).toBe(false);
    expect(isTodosComplete([])).toBe(false);
  });

  it("detects remaining work", () => {
    const todos = [
      sample({ id: "a", title: "A", status: "completed" }),
      sample({ id: "b", title: "B", status: "pending" }),
    ];
    expect(hasActiveTodos(todos)).toBe(true);
    expect(isTodosComplete(todos)).toBe(false);
  });

  it("all completed detaches strip", () => {
    const todos = [
      sample({ id: "a", title: "A", status: "completed" }),
      sample({ id: "b", title: "B", status: "completed" }),
    ];
    expect(hasActiveTodos(todos)).toBe(false);
    expect(isTodosComplete(todos)).toBe(true);
    expect(countCompleted(todos)).toBe(2);
  });
});

describe("parseTodosInput", () => {
  it("returns null for missing or empty", () => {
    expect(parseTodosInput(null)).toBeNull();
    expect(parseTodosInput({})).toBeNull();
    expect(parseTodosInput({ todos: [] })).toBeNull();
  });

  it("parses valid items and skips junk", () => {
    const todos = parseTodosInput({
      todos: [
        { id: "1", title: "Do thing", status: "in_progress" },
        { title: "", status: "pending" },
        { title: "Ship", status: "completed", description: "go" },
        null,
      ],
    });
    expect(todos).toEqual([
      {
        id: "1",
        title: "Do thing",
        description: undefined,
        status: "in_progress",
      },
      {
        id: "stream-2",
        title: "Ship",
        description: "go",
        status: "completed",
      },
    ]);
  });

  it("fingerprints status changes for memo", () => {
    const a = {
      todos: [{ id: "1", title: "X", status: "pending" }],
    };
    const b = {
      todos: [{ id: "1", title: "X", status: "completed" }],
    };
    expect(todosFingerprint(a)).not.toBe(todosFingerprint(b));
    expect(todosFingerprint(a)).toBe(todosFingerprint(a));
  });
});
