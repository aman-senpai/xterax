import { create } from "zustand";
import type { MessagePart } from "../lib/composer";

export type QueuedMessage = {
  id: string;
  sessionId: string;
  parts: MessagePart[];
  /** Snippet handles picked alongside the message. */
  snippetHandles: string[];
  /** Command names picked alongside the message. */
  commandNames: string[];
  createdAt: number;
};

type QueueState = {
  /** Messages queued keyed by session ID. */
  bySession: Record<string, QueuedMessage[]>;

  /** Enqueue a message for the given session. */
  enqueue: (
    sessionId: string,
    parts: MessagePart[],
    snippetHandles: string[],
    commandNames: string[],
  ) => void;

  /** Dequeue and return the oldest message for a session. */
  dequeue: (sessionId: string) => QueuedMessage | null;

  /** Peek at the oldest message without removing it. */
  peek: (sessionId: string) => QueuedMessage | null;

  /** Count of queued messages for a session. */
  count: (sessionId: string) => number;

  /** Clear all queued messages for a session. */
  clear: (sessionId: string) => void;
};

let nextId = 1;
function newQueueId(): string {
  return `qmsg-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export const useQueueStore = create<QueueState>((set, get) => ({
  bySession: {},

  enqueue: (sessionId, parts, snippetHandles, commandNames) => {
    const msg: QueuedMessage = {
      id: newQueueId(),
      sessionId,
      parts,
      snippetHandles,
      commandNames,
      createdAt: Date.now(),
    };
    set((s) => {
      const list = s.bySession[sessionId] ?? [];
      return { bySession: { ...s.bySession, [sessionId]: [...list, msg] } };
    });
  },

  dequeue: (sessionId) => {
    const list = get().bySession[sessionId];
    if (!list || list.length === 0) return null;
    const [head, ...tail] = list;
    set((s) => ({
      bySession: { ...s.bySession, [sessionId]: tail },
    }));
    return head;
  },

  peek: (sessionId) => {
    const list = get().bySession[sessionId];
    if (!list || list.length === 0) return null;
    return list[0];
  },

  count: (sessionId) => get().bySession[sessionId]?.length ?? 0,

  clear: (sessionId) => {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      return { bySession: next };
    });
  },
}));
