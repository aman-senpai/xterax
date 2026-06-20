import { create } from "zustand";
import { native } from "../lib/native";

export type QueuedEdit = {
  id: string;
  /** Tool that produced the queued mutation. */
  kind: "write_file" | "edit" | "multi_edit" | "create_directory";
  path: string;
  /** Original file content (empty for new files / create_directory). */
  originalContent: string;
  /** Proposed full content after edit (empty for create_directory). */
  proposedContent: string;
  /** True if the file did not exist when the edit was queued. */
  isNewFile: boolean;
  /** Human-readable description, used for create_directory. */
  description?: string;
};

type PlanSource = "user" | "agent" | null;

type PlanState = {
  active: boolean;
  queue: QueuedEdit[];
  source: PlanSource;
  toggle: () => void;
  enable: (source?: "user" | "agent") => void;
  disable: () => void;
  enqueue: (q: QueuedEdit) => void;
  removeOne: (id: string) => void;
  clear: () => void;
  /** Apply queued edits in order. Returns per-edit results. */
  applyAll: () => Promise<{ id: string; ok: boolean; error?: string }[]>;
};

let nextId = 1;
export function newQueuedEditId(): string {
  return `q-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  active: false,
  queue: [],
  source: null,
  toggle: () =>
    set((s) => ({
      active: !s.active,
      queue: s.active ? [] : s.queue,
      source: s.active ? null : "user",
    })),
  enable: (source = "user") => set({ active: true, source }),
  disable: () => set({ active: false, queue: [], source: null }),
  enqueue: (q) => set((s) => ({ queue: [...s.queue, q] })),
  removeOne: (id) =>
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clear: () => set({ queue: [] }),
  async applyAll() {
    const items = get().queue;
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const q of items) {
      try {
        if (q.kind === "create_directory") {
          await native.createDir(q.path);
        } else {
          await native.writeFile(q.path, q.proposedContent);
        }
        results.push({ id: q.id, ok: true });
      } catch (e) {
        results.push({ id: q.id, ok: false, error: String(e) });
      }
    }
    set({ queue: [] });
    return results;
  },
}));
