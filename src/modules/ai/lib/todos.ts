import { LazyStore } from "@tauri-apps/plugin-store";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: TodoStatus;
};

const STORE_PATH = "xterax-todos.json";
const todosKey = (sessionId: string) => `todos:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadTodos(sessionId: string): Promise<Todo[]> {
  return (await store.get<Todo[]>(todosKey(sessionId))) ?? [];
}

export async function saveTodos(
  sessionId: string,
  todos: Todo[],
): Promise<void> {
  await store.set(todosKey(sessionId), todos);
}

export async function deleteTodos(sessionId: string): Promise<void> {
  await store.delete(todosKey(sessionId));
}

export function newTodoId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Validate a candidate todo list:
 *  - At most one item with status `in_progress` (anti-drift invariant).
 *  - Titles must be non-empty.
 * Returns null on valid, otherwise an error string.
 */
export function validateTodos(todos: Todo[]): string | null {
  let inProgress = 0;
  for (const t of todos) {
    if (!t.title.trim()) return "todo title cannot be empty";
    if (t.status === "in_progress") inProgress++;
  }
  if (inProgress > 1)
    return `only one todo may be in_progress at a time (got ${inProgress})`;
  return null;
}

const TODO_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

/** True when the list has work left (pending or in_progress). */
export function hasActiveTodos(todos: Todo[]): boolean {
  return todos.some((t) => t.status !== "completed");
}

/** True when the list is non-empty and every item is completed. */
export function isTodosComplete(todos: Todo[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === "completed");
}

export function countCompleted(todos: Todo[]): number {
  let n = 0;
  for (const t of todos) if (t.status === "completed") n++;
  return n;
}

/**
 * Parse a `todo_write` tool input payload into todos.
 * Tolerates partial/streaming shapes; returns null when unusable.
 */
export function parseTodosInput(input: unknown): Todo[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const out: Todo[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title : "";
    if (!title.trim()) continue;
    const status =
      typeof o.status === "string" && TODO_STATUSES.has(o.status as TodoStatus)
        ? (o.status as TodoStatus)
        : "pending";
    const id =
      typeof o.id === "string" && o.id.length > 0 ? o.id : `stream-${i}`;
    const description =
      typeof o.description === "string" ? o.description : undefined;
    out.push({ id, title, description, status });
  }
  return out.length > 0 ? out : null;
}

/** Cheap fingerprint for memo compares (status + title per item). */
export function todosFingerprint(input: unknown): string {
  const todos = parseTodosInput(input);
  if (!todos) return "";
  return todos.map((t) => `${t.id}:${t.status}:${t.title}`).join("|");
}
