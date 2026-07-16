import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
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
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  CodeIcon,
  CopyIcon,
  File01Icon,
  HashtagIcon,
  RefreshIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { SLASH_COMMANDS, XTERAX_CMD_RE } from "../lib/slashCommands";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { useChatStore } from "../store/chatStore";
import { sendMessage } from "../store/chatRuntime";
import { useRewindStore } from "../store/rewindStore";
import { useMutationStore } from "../store/mutationStore";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiToolApproval } from "./AiToolApproval";
import { getActiveAgent, resolveToolPolicy } from "../lib/permissions";
import { getContinueMessage } from "../lib/prompts";

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE = /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-70">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const agentMetaStatus = useChatStore((s) => s.agentMeta.status);
  const pipelineBusy =
    agentMetaStatus === "thinking" || agentMetaStatus === "streaming";
  // Pipeline runs update messages outside Chat status — still show progress.
  const showSpinner =
    (isBusy && lastMessage?.role === "user") ||
    (pipelineBusy && !isBusy && lastMessage?.role === "user");
  const streamingMessageId =
    (status === "streaming" || pipelineBusy) &&
    lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;
  const step = useChatStore((s) => s.agentMeta.step);
  const hitStepCap = useChatStore((s) => s.agentMeta.hitStepCap);
  const compactionNotice = useChatStore((s) => s.agentMeta.compactionNotice);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);
  const showContinue =
    !isBusy && hitStepCap && lastMessage?.role === "assistant";

  const onApproval = useCallback(
    (id: string, approved: boolean) => {
      if (!approved) {
        const part = findToolPartByApproval(messages, id);
        const toolName = part ? toolNameOf(part) : "tool";
        const evidence = part ? toolEvidence(part) : "user rejected";
        void import("@/modules/engineering-profile/learningAgent").then(
          ({ notifyToolRejection }) => notifyToolRejection(toolName, evidence),
        );
      }
      addToolApprovalResponse({ id, approved });
    },
    [addToolApprovalResponse, messages],
  );

  const pendingApprovals = useMemo(() => {
    const ids: string[] = [];
    for (const m of messages) {
      for (const p of m.parts) {
        const part = p as AnyToolPart;
        if (part.state === "approval-requested" && part.approval?.id) {
          ids.push(part.approval.id);
        }
      }
    }
    return ids;
  }, [messages]);

  const pendingCount = pendingApprovals.length;

  const onApproveAll = useCallback(() => {
    for (const id of pendingApprovals) {
      addToolApprovalResponse({ id, approved: true });
    }
  }, [pendingApprovals, addToolApprovalResponse]);

  const onDenyAll = useCallback(() => {
    for (const id of pendingApprovals) {
      addToolApprovalResponse({ id, approved: false });
    }
  }, [pendingApprovals, addToolApprovalResponse]);

  useEffect(() => {
    if (pendingCount === 0) return;
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        onApproveAll();
      } else if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        onDenyAll();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pendingCount, onApproveAll, onDenyAll]);

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask Xterax anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation>
      <ConversationContent className="gap-5 p-3">
        {messages.map((m, idx) => (
          <RenderedMessage
            key={m.id}
            message={m}
            messageIndex={idx}
            onApproval={onApproval}
            streaming={m.id === streamingMessageId}
            pendingCount={pendingCount}
            onApproveAll={onApproveAll}
            onDenyAll={onDenyAll}
          />
        ))}
        {compactionNotice && (
          <CompactionNotice
            droppedCount={compactionNotice.droppedCount}
            onDismiss={() => patchAgentMeta({ compactionNotice: null })}
          />
        )}
        {showSpinner && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span className="truncate">{step ?? "Thinking…"}</span>
          </div>
        )}
        {showContinue && (
          <ContinueRow
            onContinue={() => {
              patchAgentMeta({ hitStepCap: false });
              void sendMessage(getContinueMessage());
            }}
          />
        )}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

const CompactionNotice = memo(function CompactionNotice({
  droppedCount,
  onDismiss,
}: {
  droppedCount: number;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500/80" />
      <span className="flex-1 truncate">
        Context compacted — {droppedCount} older tool result
        {droppedCount === 1 ? "" : "s"} elided to save tokens.
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10.5px] underline opacity-70 hover:opacity-100"
      >
        Dismiss
      </button>
    </div>
  );
});

const ContinueRow = memo(function ContinueRow({
  onContinue,
}: {
  onContinue: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-1.5 text-[11px]">
      <span className="flex-1 text-muted-foreground">
        Hit the step limit. Continue to keep going.
      </span>
      <button
        type="button"
        onClick={onContinue}
        className="rounded-md border border-border/60 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
      >
        Continue
      </button>
    </div>
  );
});

const CopyMessageButton = memo(function CopyMessageButton({
  text,
  label,
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* swallow */
    }
  };

  return (
    <Button
      type="button"
      size={label ? "xs" : "icon-xs"}
      variant="ghost"
      onClick={onCopy}
      className={cn(
        "text-muted-foreground hover:bg-muted/40 hover:text-foreground rounded-md transition-colors",
        label ? "h-6 gap-1.5 px-2 text-[10px]" : "size-6",
      )}
      aria-label={label || "Copy message"}
      title={label || "Copy message"}
    >
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle01Icon : CopyIcon}
        size={label ? 11 : 12}
        strokeWidth={1.75}
      />
      {label && <span>{copied ? "Copied" : label}</span>}
    </Button>
  );
});

const RewindButton = memo(function RewindButton({
  messageIndex,
}: {
  messageIndex: number;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "rewinding">("idle");
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onRewind = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (phase === "rewinding") return;
    if (phase === "idle") {
      setPhase("confirm");
      tRef.current = window.setTimeout(() => setPhase("idle"), 3000);
      return;
    }
    // phase === "confirm"
    const sessionId = useChatStore.getState().activeSessionId;
    if (!sessionId) return;
    setPhase("rewinding");
    void useRewindStore.getState().rewind(sessionId, messageIndex).finally(() => {
      setPhase("idle");
    });
  }, [phase, messageIndex]);

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      onClick={onRewind}
      disabled={phase === "rewinding"}
      className={cn(
        "size-6 rounded-md transition-colors",
        phase === "confirm"
          ? "bg-amber-500/10 text-amber-600 hover:bg-amber-500/20"
          : phase === "rewinding"
            ? "text-amber-500/60"
            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
      aria-label={
        phase === "rewinding"
          ? "Rewinding…"
          : phase === "confirm"
            ? "Click again to confirm rewind"
            : "Rewind to here"
      }
      title={
        phase === "rewinding"
          ? "Rewinding…"
          : phase === "confirm"
            ? "Click again to confirm rewind"
            : "Rewind to here"
      }
    >
      <HugeiconsIcon
        icon={RefreshIcon}
        size={12}
        strokeWidth={1.75}
        className={phase === "rewinding" ? "animate-spin" : ""}
      />
    </Button>
  );
});

const RestoreMessageFilesButton = memo(function RestoreMessageFilesButton({
  messageId,
}: {
  messageId: string;
}) {
  const [phase, setPhase] = useState<"idle" | "confirm" | "restoring">("idle");
  const tRef = useRef<number>(0);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const count = useMutationStore((s) => {
    if (!activeSessionId) return 0;
    return (
      s.bySession[activeSessionId]?.filter((m) => m.messageId === messageId)
        .length ?? 0
    );
  });

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onRestore = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (phase === "restoring") return;
      if (phase === "idle") {
        setPhase("confirm");
        tRef.current = window.setTimeout(() => setPhase("idle"), 3000);
        return;
      }
      // phase === "confirm"
      const sessionId = useChatStore.getState().activeSessionId;
      if (!sessionId) return;
      setPhase("restoring");
      void useMutationStore
        .getState()
        .restore(sessionId, messageId)
        .finally(() => {
          setPhase("idle");
        });
    },
    [phase, messageId],
  );

  if (count === 0) return null;

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      onClick={onRestore}
      disabled={phase === "restoring"}
      className={cn(
        "size-6 rounded-md gap-1 transition-colors",
        phase === "confirm"
          ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
          : phase === "restoring"
            ? "text-emerald-500/60"
            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
      )}
      aria-label={
        phase === "restoring"
          ? `Restoring ${count} file(s)…`
          : phase === "confirm"
            ? `Click again to restore ${count} file(s)`
            : `Restore ${count} file(s)`
      }
      title={
        phase === "restoring"
          ? `Restoring ${count} file(s)…`
          : phase === "confirm"
            ? `Click again to restore ${count} file(s)`
            : `Restore ${count} file(s)`
      }
    >
      <HugeiconsIcon
        icon={RefreshIcon}
        size={12}
        strokeWidth={1.75}
        className={phase === "restoring" ? "animate-spin" : ""}
      />
      <span className="text-[10px] font-medium">{count}</span>
    </Button>
  );
});

const RenderedMessage = memo(function RenderedMessage({
  message,
  messageIndex,
  onApproval,
  streaming,
  pendingCount,
  onApproveAll,
  onDenyAll,
}: {
  message: UIMessage;
  messageIndex: number;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  pendingCount: number;
  onApproveAll: () => void;
  onDenyAll: () => void;
}) {
  // Index of the trailing text part — only that one is "live" mid-stream.
  // Earlier text parts (separated by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(XTERAX_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    return (
      <Message from="user">
        <div className="relative group/user-msg flex items-center gap-2 max-w-full">
          <div className="opacity-0 group-hover/user-msg:opacity-100 transition-opacity duration-150 shrink-0">
            <CopyMessageButton text={stripped.text || rawText} />
          </div>
          <MessageContent>
            {commandName ? <CommandSnippet name={commandName} /> : null}
            {stripped.chips.length > 0 ? (
              <ContextChips chips={stripped.chips} />
            ) : null}
            {stripped.text ? (
              <p className="whitespace-pre-wrap wrap-break-word">
                {renderTextWithAgentMentions(stripped.text)}
              </p>
            ) : null}
          </MessageContent>
        </div>
      </Message>
    );
  }

  const groups = useMemo(
    () => buildPartGroups(message.parts as AnyPart[]),
    [message.parts],
  );

  const assistantText = useMemo(() => {
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }, [message.parts]);

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            const isReadSingle =
              partType(g.part) === "tool-read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  part={g.part}
                  onApproval={onApproval}
                  streaming={streaming && g.idx === lastTextIdx}
                  pendingCount={pendingCount}
                  onApproveAll={onApproveAll}
                  onDenyAll={onDenyAll}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
      {assistantText && (
        <div className="mt-1 flex items-center justify-start gap-1 px-1">
          <CopyMessageButton text={assistantText} label="Copy response" />
          <RestoreMessageFilesButton messageId={message.id} />
          <RewindButton messageIndex={messageIndex} />
        </div>
      )}
    </Message>
  );
});

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string };

/** Highlight @agent handles in user bubbles (same chip look as the composer). */
function renderTextWithAgentMentions(text: string): React.ReactNode {
  const re = /@([a-z][a-z0-9-]*)/gi;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(text.slice(last, m.index));
    }
    nodes.push(
      <span
        key={`m-${key++}`}
        className="mx-0.5 inline-flex items-center rounded bg-sky-500/15 px-1 py-px align-baseline font-mono text-[0.92em] font-medium text-sky-600 dark:text-sky-400"
      >
        @{m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length > 0 ? nodes : text;
}

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: "reads",
        parts: run.parts,
        key: `reads-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      run.parts.forEach((p, k) => {
        const idx = run!.startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  return out;
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Read</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} file{count === 1 ? "" : "s"}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="xterax-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">{basename(path)}</span>
              <span className="truncate opacity-60">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out">
      {children}
    </div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-medium text-foreground">Read</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
  pendingCount,
  onApproveAll,
  onDenyAll,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  pendingCount: number;
  onApproveAll: () => void;
  onDenyAll: () => void;
}) {
  if (part.type === "text") {
    return (
      <MessageResponse streaming={streaming}>
        {(part as unknown as { text: string }).text}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>
          {(part as unknown as { text: string }).text}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
        pendingCount={pendingCount}
        onApproveAll={onApproveAll}
        onDenyAll={onDenyAll}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
  pendingCount,
  onApproveAll,
  onDenyAll,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
  pendingCount: number;
  onApproveAll: () => void;
  onDenyAll: () => void;
}) {
  const permissionMode = useChatStore((s) => s.permissionMode);
  const respondedRef = useRef(false);
  const onApprovalRef = useRef(onApproval);
  onApprovalRef.current = onApproval;

  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  const policy = useMemo(
    () =>
      part.state === "approval-requested"
        ? resolveToolPolicy(
            toolName,
            permissionMode,
            part.input,
            getActiveAgent(),
          )
        : null,
    [part.state, toolName, permissionMode, part.input],
  );

  useEffect(() => {
    if (part.state !== "approval-requested") return;
    if (policy === "ask") return;
    const approval = part.approval;
    if (!approval) return;
    if (respondedRef.current) return;
    respondedRef.current = true;
    onApprovalRef.current(approval.id, policy === "auto-approve");
  }, [policy, part.approval?.id, part.state]);

  if (part.state === "approval-requested") {
    if (policy !== "ask" && respondedRef.current) {
      return <AutoApprovalBadge approved={policy === "auto-approve"} />;
    }
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
        pendingCount={pendingCount}
        onApproveAll={onApproveAll}
        onDenyAll={onDenyAll}
      />
    );
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      defaultOpen={toolName === "list_directory"}
    />
  );
});

function AutoApprovalBadge({ approved }: { approved: boolean }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-card/50 px-2.5 py-1.5 text-[11px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          approved ? "bg-emerald-500" : "bg-destructive",
        )}
      />
      <span
        className={cn(
          "font-medium",
          approved ? "text-emerald-500" : "text-destructive",
        )}
      >
        {approved ? "Auto-approved" : "Auto-denied"}
      </span>
    </div>
  );
}

type LooseToolPart = {
  type: string;
  state?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  approval?: { id?: string };
  errorText?: string;
};

function findToolPartByApproval(
  messages: { parts: unknown[] }[],
  approvalId: string,
): LooseToolPart | null {
  for (const m of messages) {
    for (const p of m.parts) {
      const part = p as LooseToolPart;
      if (part?.approval?.id === approvalId) return part;
    }
  }
  return null;
}

function toolNameOf(part: LooseToolPart): string {
  if (part.type === "dynamic-tool" && part.toolName) return part.toolName;
  return part.type.replace(/^tool-/, "");
}

function toolEvidence(part: LooseToolPart): string {
  const name = toolNameOf(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path : null;
  const cmd = typeof input.command === "string" ? input.command : null;
  if (path) return `user rejected ${name} on ${path}`;
  if (cmd) return `user rejected ${name} (${cmd.slice(0, 80)})`;
  return `user rejected ${name}`;
}
