import type {
  AcpMessagePart,
  AcpSessionUpdate,
  AcpTranscriptMessage,
} from "./types";

function contentText(content: { type: string; text?: string }): string {
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

/**
 * Apply one ACP `session/update` to a mutable transcript.
 * Pure: returns a new messages array.
 */
export function applyAcpUpdate(
  messages: AcpTranscriptMessage[],
  update: AcpSessionUpdate,
): AcpTranscriptMessage[] {
  const kind = update.sessionUpdate;

  if (
    kind === "agent_message_chunk" ||
    kind === "agent_thought_chunk" ||
    kind === "user_message_chunk"
  ) {
    const content =
      "content" in update && update.content && typeof update.content === "object"
        ? (update.content as { type: string; text?: string })
        : { type: "text", text: "" };
    const text = contentText(content);
    if (!text) return messages;

    const role =
      kind === "user_message_chunk" ? ("user" as const) : ("assistant" as const);
    const partType =
      kind === "agent_thought_chunk" ? ("reasoning" as const) : ("text" as const);

    const last = messages[messages.length - 1];
    const canAppend =
      last &&
      last.role === role &&
      (kind !== "user_message_chunk" || last.role === "user");

    if (canAppend && last) {
      const parts = [...last.parts];
      const lastPart = parts[parts.length - 1];
      if (lastPart && lastPart.type === partType) {
        parts[parts.length - 1] = {
          ...lastPart,
          text: lastPart.text + text,
        };
      } else {
        parts.push(
          partType === "reasoning"
            ? { type: "reasoning", text }
            : { type: "text", text },
        );
      }
      return [...messages.slice(0, -1), { ...last, parts }];
    }

    const messageId =
      "messageId" in update && typeof update.messageId === "string"
        ? update.messageId
        : undefined;
    const msg: AcpTranscriptMessage = {
      id: messageId ?? `acp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role,
      parts: [
        partType === "reasoning"
          ? { type: "reasoning", text }
          : { type: "text", text },
      ],
      createdAt: Date.now(),
    };
    return [...messages, msg];
  }

  if (kind === "tool_call") {
    const u = update as Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }>;
    const part: AcpMessagePart = {
      type: "tool",
      toolCallId: u.toolCallId,
      title: u.title ?? u.toolCallId,
      kind: u.kind ?? "other",
      status: u.status ?? "pending",
      content: u.content,
    };
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      return [
        ...messages.slice(0, -1),
        { ...last, parts: [...last.parts, part] },
      ];
    }
    return [
      ...messages,
      {
        id: `acp-tool-${u.toolCallId}`,
        role: "assistant",
        parts: [part],
        createdAt: Date.now(),
      },
    ];
  }

  if (kind === "tool_call_update") {
    const u = update as Extract<
      AcpSessionUpdate,
      { sessionUpdate: "tool_call_update" }
    >;
    return messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
        if (p.type !== "tool" || p.toolCallId !== u.toolCallId) return p;
        return {
          ...p,
          title: u.title ?? p.title,
          kind: u.kind ?? p.kind,
          status: u.status ?? p.status,
          content: u.content !== undefined ? u.content : p.content,
        };
      }),
    }));
  }

  if (kind === "plan") {
    const u = update as Extract<AcpSessionUpdate, { sessionUpdate: "plan" }>;
    const part: AcpMessagePart = { type: "plan", entries: u.entries ?? [] };
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      const withoutPlan = last.parts.filter((p) => p.type !== "plan");
      return [
        ...messages.slice(0, -1),
        { ...last, parts: [...withoutPlan, part] },
      ];
    }
    return [
      ...messages,
      {
        id: `acp-plan-${Date.now()}`,
        role: "assistant",
        parts: [part],
        createdAt: Date.now(),
      },
    ];
  }

  return messages;
}

export function appendUserText(
  messages: AcpTranscriptMessage[],
  text: string,
): AcpTranscriptMessage[] {
  return [
    ...messages,
    {
      id: `acp-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      parts: [{ type: "text", text }],
      createdAt: Date.now(),
    },
  ];
}
