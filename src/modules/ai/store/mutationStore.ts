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
  /** Turn id assigned at record time; later mapped to an assistant message id. */
  turnId: string | null;
  /** The assistant message id that produced this mutation (set after turn completes). */
  messageId: string | null;
};

type MutationState = {
  /** Mutations keyed by session ID. */
  bySession: Record<string, FileMutation[]>;

  record: (m: Omit<FileMutation, "id" | "at" | "messageId">) => void;

  /** After a turn completes, associate all mutations with the given turnId
   *  to the assistant message id. */
  assignMessageId: (
    sessionId: string,
    turnId: string,
    messageId: string,
  ) => void;

  /** Revert file mutations for a specific assistant message (reverse order).
   *  Pass only sessionId to revert ALL mutations for the session. */
  restore: (
    sessionId: string,
    messageId?: string,
  ) => Promise<{ ok: number; failed: number }>;

  /** Get mutations for a session, optionally filtered by message id. */
  getForSession: (sessionId: string, messageId?: string) => FileMutation[];

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
    const entry: FileMutation = {
      ...m,
      id: newMutationId(),
      at: Date.now(),
      messageId: null,
    };
    set((s) => {
      const list = s.bySession[m.sessionId] ?? [];
      return { bySession: { ...s.bySession, [m.sessionId]: [...list, entry] } };
    });
  },

  assignMessageId: (sessionId, turnId, messageId) => {
    set((s) => {
      const list = s.bySession[sessionId];
      if (!list) return s;
      let changed = false;
      const next = list.map((m) => {
        if (m.turnId === turnId && m.messageId === null) {
          changed = true;
          return { ...m, messageId };
        }
        return m;
      });
      if (!changed) return s;
      return { bySession: { ...s.bySession, [sessionId]: next } };
    });
  },

  restore: async (sessionId, messageId?) => {
    const list = get().bySession[sessionId];
    if (!list || list.length === 0) return { ok: 0, failed: 0 };

    const targets = messageId
      ? list.filter((m) => m.messageId === messageId)
      : list;

    if (targets.length === 0) return { ok: 0, failed: 0 };

    let ok = 0;
    let failed = 0;
    const restoredIds = new Set<string>();
    // Reverse order: undo the last mutation first.
    const reversed = [...targets].reverse();

    for (const m of reversed) {
      try {
        if (m.isNewFile || m.kind === "create_directory") {
          await native.deleteEntry(m.path);
        } else {
          await native.writeFile(m.path, m.originalContent);
        }
        restoredIds.add(m.id);
        ok++;
      } catch (e) {
        console.warn(`[mutationStore] restore failed for ${m.path}:`, e);
        failed++;
      }
    }

    // Drop only mutations that actually restored so failed paths can retry.
    if (restoredIds.size > 0) {
      set((s) => {
        const remaining = (s.bySession[sessionId] ?? []).filter(
          (m) => !restoredIds.has(m.id),
        );
        const bySession = { ...s.bySession };
        if (remaining.length === 0) {
          delete bySession[sessionId];
        } else {
          bySession[sessionId] = remaining;
        }
        return { bySession };
      });
    }

    return { ok, failed };
  },

  getForSession: (sessionId, messageId?) => {
    const list = get().bySession[sessionId] ?? [];
    if (!messageId) return list;
    return list.filter((m) => m.messageId === messageId);
  },

  clear: (sessionId) => {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
