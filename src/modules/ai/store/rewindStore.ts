import { create } from "zustand";
import {
  chats,
  cancelPersist,
} from "./chatStore";
import { saveMessages } from "../lib/sessions";
import type { UIMessage } from "@ai-sdk/react";

type RewindState = {
  /** Rewind a session to a specific message index.
   *  Messages at and after `messageIndex` are discarded. */
  rewind: (
    sessionId: string,
    messageIndex: number,
  ) => Promise<{ ok: boolean; removed: number }>;
};

export const useRewindStore = create<RewindState>(() => ({
  rewind: async (sessionId, messageIndex) => {
    const chat = chats.get(sessionId);
    if (!chat) return { ok: false, removed: 0 };

    const messages = chat.messages as readonly UIMessage[];
    if (messageIndex < 0 || messageIndex >= messages.length) {
      return { ok: false, removed: 0 };
    }

    // Keep messages up to (but not including) the target message.
    const kept = messages.slice(0, messageIndex) as UIMessage[];
    const removed = messages.length - kept.length;

    // Stop any in-flight request.
    void chat.stop();

    // Mutate messages directly on the existing Chat instance. The Chat's
    // internal setter triggers all subscribed useChat hooks so the UI
    // reflects the truncated history immediately — no Chat swap needed.
    chat.messages = kept as UIMessage[];

    // Cancel any pending debounced persist to prevent the old full message
    // set from racing against the truncated messages we're about to save.
    cancelPersist(sessionId);

    // Persist the truncated messages to disk.
    await saveMessages(sessionId, kept as UIMessage[]);

    return { ok: true, removed };
  },
}));
