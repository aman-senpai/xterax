import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAcpStore,
  type AcpMessagePart,
  type AcpPermissionRequest,
  type AcpTranscriptMessage,
} from "@/modules/acp";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { Spinner } from "@/components/ui/spinner";
import { CheckmarkCircle01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useMemo } from "react";

// Stable empties — Zustand + useSyncExternalStore throws / freezes the tree
// if a selector returns a fresh [] every snapshot.
const EMPTY_MESSAGES: AcpTranscriptMessage[] = [];
const EMPTY_PERMISSIONS: AcpPermissionRequest[] = [];

export function AcpChatView({ sessionId }: { sessionId: string }) {
  const binding = useAcpStore((s) => s.bindings[sessionId]);
  const acpSessionId = binding?.acpSessionId;
  const connectionId = binding?.connectionId;

  const messages = useAcpStore((s) =>
    acpSessionId
      ? (s.transcripts[acpSessionId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const allPending = useAcpStore((s) => s.pendingPermissions);
  const pending = useMemo(() => {
    if (!connectionId || allPending.length === 0) return EMPTY_PERMISSIONS;
    const filtered = allPending.filter((p) => p.connectionId === connectionId);
    return filtered.length === 0 ? EMPTY_PERMISSIONS : filtered;
  }, [allPending, connectionId]);

  const error = useChatStore((s) => s.agentMeta.error);
  const status = useChatStore((s) => s.agentMeta.status);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-3 px-3 py-3">
          {messages.length === 0 && !error ? (
            <div className="px-1 py-6 text-center text-[11px] text-muted-foreground">
              ACP agent selected. Send a message to start a session.
            </div>
          ) : null}
          {messages.map((m) => (
            <AcpMessageRow key={m.id} message={m} />
          ))}
          {status === "streaming" || status === "thinking" ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              Agent working…
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              {error}
            </div>
          ) : null}
          {pending.map((p) => (
            <AcpPermissionCard
              key={`${p.connectionId}-${p.requestId}`}
              req={p}
            />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
    </div>
  );
}

const AcpMessageRow = memo(function AcpMessageRow({
  message,
}: {
  message: AcpTranscriptMessage;
}) {
  const isUser = message.role === "user";
  return (
    <Message from={isUser ? "user" : "assistant"}>
      <MessageContent>
        {message.parts.map((part, i) => (
          <AcpPart key={i} part={part} />
        ))}
      </MessageContent>
    </Message>
  );
});

function AcpPart({ part }: { part: AcpMessagePart }) {
  if (part.type === "text") {
    return <MessageResponse>{part.text}</MessageResponse>;
  }
  if (part.type === "reasoning") {
    return (
      <Reasoning defaultOpen={false}>
        <ReasoningTrigger />
        <ReasoningContent>{part.text}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === "tool") {
    return (
      <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-[11px]">
        <div className="flex items-center gap-1.5 font-medium">
          <span className="truncate">{part.title}</span>
          <span
            className={cn(
              "ml-auto shrink-0 text-[10px] uppercase tracking-wide",
              part.status === "completed" && "text-emerald-500",
              part.status === "failed" && "text-destructive",
              part.status === "in_progress" && "text-amber-500",
              part.status === "pending" && "text-muted-foreground",
            )}
          >
            {part.status}
          </span>
        </div>
        {part.kind ? (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {part.kind}
          </div>
        ) : null}
      </div>
    );
  }
  if (part.type === "plan") {
    return (
      <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Plan
        </div>
        <ul className="flex flex-col gap-1">
          {part.entries.map((e, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11px] text-foreground/90"
            >
              <HugeiconsIcon
                icon={CheckmarkCircle01Icon}
                size={12}
                strokeWidth={1.75}
                className={cn(
                  "mt-0.5 shrink-0",
                  e.status === "completed"
                    ? "text-emerald-500"
                    : "text-muted-foreground/50",
                )}
              />
              <span>{e.content}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

function AcpPermissionCard({ req }: { req: AcpPermissionRequest }) {
  const respond = useAcpStore((s) => s.respondPermission);
  const options = Array.isArray(req.options) ? req.options : [];
  const toolTitle =
    req.toolCall &&
    typeof req.toolCall === "object" &&
    "title" in req.toolCall &&
    typeof (req.toolCall as { title?: unknown }).title === "string"
      ? (req.toolCall as { title: string }).title
      : "Tool permission";

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="text-[11.5px] font-medium">{toolTitle}</div>
      <div className="mt-0.5 text-[10.5px] text-muted-foreground">
        Agent requests permission to continue
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <Button
            key={opt.optionId}
            size="sm"
            variant={
              opt.kind?.startsWith("reject") ? "outline" : "default"
            }
            className="h-7 text-[11px]"
            onClick={() =>
              void respond(
                req.connectionId,
                req.requestId,
                "selected",
                opt.optionId,
              )
            }
          >
            {opt.name}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[11px]"
          onClick={() =>
            void respond(req.connectionId, req.requestId, "cancelled")
          }
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
