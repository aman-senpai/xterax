import { create } from "zustand";
import {
  chats,
  flushPersist,
  seedMessages,
} from "./chatStore";
import type { UIMessage } from "@ai-sdk/react";

type RewindState = {
  /** Rewind a session to a specific message index.
   *  Messages at and after `messageIndex` are discarded. */
  rewind: (
    sessionId: string,
    messageIndex: number,
  ) => { ok: boolean; removed: number };
};

export const useRewindStore = create<RewindState>(() => ({
  rewind: (sessionId, messageIndex) => {
    const chat = chats.get(sessionId);
    if (!chat) return { ok: false, removed: 0 };

    const messages = chat.messages as readonly UIMessage[];
    if (messageIndex < 0 || messageIndex >= messages.length) {
      return { ok: false, removed: 0 };
    }

    // Keep messages up to (but not including) the target message.
    const kept = messages.slice(0, messageIndex) as UIMessage[];
    const removed = messages.length - kept.length;

    // Stop any in-flight request, then seed the truncated messages so the
    // next time the session is opened it picks up the truncated history.
    void chat.stop();
    chats.delete(sessionId);
    seedMessages.set(sessionId, kept as UIMessage[]);

    // Persist the truncated messages.
    flushPersist(sessionId);
    void import("../lib/sessions").then(({ saveMessages }) =>
      saveMessages(sessionId, kept as UIMessage[]),
    );

    return { ok: true, removed };
  },
}));
