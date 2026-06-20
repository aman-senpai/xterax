import { create } from "zustand";
import { native } from "../lib/native";

export type FileMutation = {
  id: string;
  sessionId: string;
  /** Tool that produced the mutation. */
  kind: "write_file" | "edit" | "multi_edit" | "create_directory";
  path: string;
  /** Original file content (empty for new files / create_directory). */
  originalContent: string;
  /** New content after mutation (empty for create_directory). */
  newContent: string;
  /** True if the file did not exist before the mutation. */
  isNewFile: boolean;
  /** Unix timestamp of the mutation. */
  at: number;
};

type MutationState = {
  /** Mutations keyed by session ID. */
  bySession: Record<string, FileMutation[]>;

  record: (m: Omit<FileMutation, "id" | "at">) => void;
  /** Revert all mutations for a session in reverse order. */
  restore: (sessionId: string) => Promise<{ ok: number; failed: number }>;
  /** Get mutations for a session. */
  getForSession: (sessionId: string) => FileMutation[];
  /** Clear mutations for a session. */
  clear: (sessionId: string) => void;
};

let nextId = 1;
function newMutationId(): string {
  return `mut-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export const useMutationStore = create<MutationState>((set, get) => ({
  bySession: {},

  record: (m) => {
    const entry: FileMutation = { ...m, id: newMutationId(), at: Date.now() };
    set((s) => {
      const list = s.bySession[m.sessionId] ?? [];
      return { bySession: { ...s.bySession, [m.sessionId]: [...list, entry] } };
    });
  },

  restore: async (sessionId: string) => {
    const list = get().bySession[sessionId];
    if (!list || list.length === 0) return { ok: 0, failed: 0 };

    let ok = 0;
    let failed = 0;
    // Reverse order: undo the last mutation first.
    const reversed = [...list].reverse();

    for (const m of reversed) {
      try {
        if (m.isNewFile || m.kind === "create_directory") {
          // File or directory was created by the agent — delete it.
          await native.deleteEntry(m.path);
          ok++;
          continue;
        }
        // Restore original content.
        await native.writeFile(m.path, m.originalContent);
        ok++;
      } catch (e) {
        console.warn(`[mutationStore] restore failed for ${m.path}:`, e);
        failed++;
      }
    }

    // Clear after successful restore.
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });

    return { ok, failed };
  },

  getForSession: (sessionId: string) => get().bySession[sessionId] ?? [],

  clear: (sessionId: string) => {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
