import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { type UIMessage, useChat } from "@ai-sdk/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowRight01Icon,
  CheckListIcon,
  Clock01Icon,
  Delete02Icon,
  Edit02Icon,
  FilterIcon,
  FlashIcon,
  Mic01Icon,
  Queue01Icon,
  RefreshIcon,
  ShieldUserIcon,
  StopCircleIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  estimateCost,
  getModel,
  getModelContextLimit,
  type ModelId,
} from "../config";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import type { SessionMeta } from "../lib/sessions";
import { getOrCreateChat, sendMessage } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import { useMutationStore } from "../store/mutationStore";
import { usePlanStore } from "../store/planStore";
import { useQueueStore } from "../store/queueStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { AiChatView } from "./AiChat";
import { AiComposerInput } from "./AiComposerInput";
import { ModelDropdown } from "./AiStatusBarControls";
import { PlanDiffReview } from "./PlanDiffReview";
import { ThinkingModeDropdown } from "./ThinkingModeDropdown";
import { TodoStrip } from "./TodoStrip";

const SUGGESTIONS = [
  {
    label: "Explain the last error",
    hint: "Read the terminal buffer",
    icon: AlertCircleIcon,
    text: "Explain the last error in the terminal.",
  },
  {
    label: "Generate a command",
    hint: "Tell me what you want to do",
    icon: TerminalIcon,
    text: "Give me a command to ",
  },
  {
    label: "Summarize buffer",
    hint: "Recap recent activity",
    icon: FilterIcon,
    text: "Summarize what just happened in the terminal.",
  },
];

// Module-level selectors — stable references so Zustand v5's
// useSyncExternalStore consistency check doesn't trigger redundant renders
// on non-primitive (array/object) return values.
const selectCloseRightPanel = (s: ReturnType<typeof useChatStore.getState>) =>
  s.closeRightPanel;
const selectActiveSessionId = (s: ReturnType<typeof useChatStore.getState>) =>
  s.activeSessionId;
const selectFocusInput = (s: ReturnType<typeof useChatStore.getState>) =>
  s.focusInput;
const selectSessions = (s: ReturnType<typeof useChatStore.getState>) =>
  s.sessions;
const selectNewSession = (s: ReturnType<typeof useChatStore.getState>) =>
  s.newSession;
const selectSwitchSession = (s: ReturnType<typeof useChatStore.getState>) =>
  s.switchSession;
const selectDeleteSession = (s: ReturnType<typeof useChatStore.getState>) =>
  s.deleteSession;
const selectHistoryOpen = (s: ReturnType<typeof useChatStore.getState>) =>
  s.historyOpen;
const selectToggleHistory = (s: ReturnType<typeof useChatStore.getState>) =>
  s.toggleHistory;
const selectPermissionMode = (s: ReturnType<typeof useChatStore.getState>) =>
  s.permissionMode;
const selectSetPermissionMode = (s: ReturnType<typeof useChatStore.getState>) =>
  s.setPermissionMode;
const selectRenameSession = (s: ReturnType<typeof useChatStore.getState>) =>
  s.renameSession;
const selectSelectedModelId = (s: ReturnType<typeof useChatStore.getState>) =>
  s.selectedModelId;
const selectAgentTokens = (s: ReturnType<typeof useChatStore.getState>) =>
  s.agentMeta.tokens;
const selectAgentLastInputTokens = (
  s: ReturnType<typeof useChatStore.getState>,
) => s.agentMeta.lastInputTokens;
const selectAgentLastCachedTokens = (
  s: ReturnType<typeof useChatStore.getState>,
) => s.agentMeta.lastCachedTokens;
const selectPlanActive = (s: ReturnType<typeof usePlanStore.getState>) =>
  s.active;
const selectPlanQueueLen = (s: ReturnType<typeof usePlanStore.getState>) =>
  s.queue.length;
const selectPlanDisable = (s: ReturnType<typeof usePlanStore.getState>) =>
  s.disable;
const selectPlanSource = (s: ReturnType<typeof usePlanStore.getState>) =>
  s.source;
const selectAgentStatus = (s: ReturnType<typeof useChatStore.getState>) =>
  s.agentMeta.status;
const selectOpenaiCompatContextLimit = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.openaiCompatibleContextLimit;

export function RightPanel() {
  const closeRightPanel = useChatStore(selectCloseRightPanel);
  const sessionId = useChatStore(selectActiveSessionId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        closeRightPanel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeRightPanel]);

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-card text-[12px]">
      {sessionId ? <Body sessionId={sessionId} /> : <EmptyShell />}
      <PlanDiffReview />
    </div>
  );
}

function Body({ sessionId }: { sessionId: string }) {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusInput = useChatStore(selectFocusInput);
  const sessions = useChatStore(selectSessions);
  const activeId = useChatStore(selectActiveSessionId);
  const newSession = useChatStore(selectNewSession);
  const switchSession = useChatStore(selectSwitchSession);
  const deleteSession = useChatStore(selectDeleteSession);
  const historyOpen = useChatStore(selectHistoryOpen);
  const toggleHistory = useChatStore(selectToggleHistory);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const activeTitle = active?.title || "New chat";

  return (
    <>
      <Header
        sessionId={sessionId}
        title={activeTitle}
        onNewSession={() => {
          newSession();
          if (historyOpen) toggleHistory();
        }}
      />

      {historyOpen ? (
        <HistoryPanel
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => {
            switchSession(id);
            if (historyOpen) toggleHistory();
          }}
          onDelete={deleteSession}
          onNewSession={() => {
            newSession();
            if (historyOpen) toggleHistory();
          }}
        />
      ) : (
        <>
          <PlanModeStrip />
          <RestoreStrip sessionId={sessionId} />
          <QueueStrip sessionId={sessionId} />

          <div className="flex min-h-0 flex-1 flex-col">
            {helpers.messages.length === 0 ? (
              <EmptyState onPick={focusInput} />
            ) : (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
                <AiChatView
                  messages={helpers.messages}
                  status={helpers.status}
                  error={helpers.error}
                  clearError={helpers.clearError}
                  addToolApprovalResponse={helpers.addToolApprovalResponse}
                  stop={helpers.stop}
                />
              </div>
            )}
          </div>

          <TodoStrip sessionId={sessionId} />

          <div className="shrink-0 border-t border-border/60 bg-card px-3 py-2.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPTED_FILES}
              className="hidden"
              onChange={(e) => {
                void c.addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="rounded-xl border border-border/70 bg-background px-2.5 pt-2.5 pb-1.5 shadow-sm">
              <AiComposerInput />
              <div className="mt-1.5 flex min-w-0 items-center gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title="Attach file or image"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={c.isBusy}
                  className="shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                >
                  <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
                </Button>
                <div className="shrink-0">
                  <ContextIndicator messages={helpers.messages} />
                </div>
                <AgentSwitcher className="min-w-0 max-w-[7.5rem]" />
                <span className="min-w-2 flex-1" aria-hidden />
                <div className="flex shrink-0 items-center gap-0.5">
                  <ThinkingModeDropdown compact />
                  <ModelDropdown compact />
                  {c.voice.supported && c.voice.hasKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      title={
                        c.voice.recording
                          ? "Stop & transcribe"
                          : c.voice.transcribing
                            ? "Transcribing…"
                            : "Voice input"
                      }
                      onClick={() =>
                        c.voice.recording
                          ? c.voice.stop()
                          : void c.voice.start()
                      }
                      disabled={c.isBusy || c.voice.transcribing}
                      className={cn(
                        "rounded-md text-muted-foreground hover:text-foreground",
                        c.voice.recording &&
                          "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                      )}
                    >
                      {c.voice.recording ? (
                        <span className="size-2 animate-pulse rounded-full bg-destructive" />
                      ) : c.voice.transcribing ? (
                        <Spinner className="size-3" />
                      ) : (
                        <HugeiconsIcon
                          icon={Mic01Icon}
                          size={13}
                          strokeWidth={1.75}
                        />
                      )}
                    </Button>
                  )}
                  {c.isBusy ? (
                    <>
                      {c.canSend && (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          onClick={c.submit}
                          className="rounded-md text-muted-foreground hover:text-foreground"
                          aria-label="Queue message"
                          title="Queue message (will send after current turn)"
                        >
                          <HugeiconsIcon
                            icon={Queue01Icon}
                            size={13}
                            strokeWidth={1.75}
                          />
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        onClick={c.stop}
                        className="rounded-md"
                        aria-label="Stop"
                        title="Stop"
                      >
                        <HugeiconsIcon
                          icon={StopCircleIcon}
                          size={13}
                          strokeWidth={1.75}
                        />
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="icon-xs"
                      onClick={c.submit}
                      disabled={!c.canSend}
                      className="h-6 w-7 rounded-md"
                      aria-label="Send"
                      title="Send (Enter)"
                    >
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PlanModeStrip() {
  const active = usePlanStore(selectPlanActive);
  const queueLen = usePlanStore(selectPlanQueueLen);
  const source = usePlanStore(selectPlanSource);
  const agentStatus = useChatStore(selectAgentStatus);
  const disable = usePlanStore(selectPlanDisable);

  if (!active) return null;

  const isAgentWaiting = source === "agent" && agentStatus === "idle";

  const handleApprove = () => {
    disable();
    void sendMessage("Plan approved — proceed with implementation.");
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="text-[11px] font-medium text-foreground">Plan mode</span>
      {isAgentWaiting ? (
        <span className="text-[11px] text-amber-600">— awaiting approval</span>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          {queueLen > 0 ? `· ${queueLen} queued` : "· no edits queued"}
        </span>
      )}
      <span className="flex-1" />
      {isAgentWaiting && (
        <button
          type="button"
          onClick={handleApprove}
          className="rounded px-2 py-0.5 text-[10.5px] font-medium bg-amber-500 text-white transition-colors hover:bg-amber-600"
        >
          Approve plan
        </button>
      )}
      <button
        type="button"
        onClick={() => disable()}
        className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Exit
      </button>
    </div>
  );
}

function RestoreStrip({ sessionId }: { sessionId: string }) {
  const [restoring, setRestoring] = useState(false);
  const count = useMutationStore((s) => s.bySession[sessionId]?.length ?? 0);

  if (count === 0) return null;

  const handleRestore = async () => {
    setRestoring(true);
    try {
      const result = await useMutationStore.getState().restore(sessionId);
      const msg =
        result.failed === 0
          ? `Restored ${result.ok} file(s).`
          : `Restored ${result.ok} file(s), ${result.failed} failed.`;
      console.info(`[restore] ${msg}`);
    } catch (e) {
      console.warn("[restore] failed:", e);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/5 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
      <span className="text-[11px] font-medium text-foreground">Changes</span>
      <span className="text-[11px] text-muted-foreground">
        · {count} file{count === 1 ? "" : "s"} modified
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={handleRestore}
        disabled={restoring}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 hover:text-emerald-700 disabled:opacity-50"
      >
        <HugeiconsIcon
          icon={RefreshIcon}
          size={10}
          strokeWidth={2}
          className={restoring ? "animate-spin" : ""}
        />
        {restoring ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}

function QueueStrip({ sessionId }: { sessionId: string }) {
  const count = useQueueStore((s) => s.count(sessionId));
  const agentStatus = useChatStore(selectAgentStatus);
  const isBusy = agentStatus === "thinking" || agentStatus === "streaming";

  if (count === 0 && !isBusy) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-blue-500/20 bg-blue-500/5 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />
      <span className="text-[11px] font-medium text-foreground">
        {isBusy ? "Processing" : "Queued"}
      </span>
      <span className="text-[11px] text-muted-foreground">
        {isBusy && count > 0
          ? `· ${count} message${count === 1 ? "" : "s"} queued`
          : !isBusy && count > 0
            ? `· ${count} message${count === 1 ? "" : "s"} waiting`
            : "· waiting for response"}
      </span>
      <span className="flex-1" />
      {count > 0 && !isBusy && (
        <button
          type="button"
          onClick={() => useQueueStore.getState().clear(sessionId)}
          className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function EmptyShell() {
  return (
    <>
      <Header title="Loading…" onNewSession={() => {}} />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        Loading sessions…
      </div>
    </>
  );
}

function Header({
  sessionId,
  title,
  onNewSession,
}: {
  sessionId?: string | null;
  title: string;
  onNewSession: () => void;
}) {
  const historyOpen = useChatStore(selectHistoryOpen);
  const toggleHistory = useChatStore(selectToggleHistory);
  const permissionMode = useChatStore(selectPermissionMode);
  const setPermissionMode = useChatStore(selectSetPermissionMode);
  const renameSession = useChatStore(selectRenameSession);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset editing state on session switch
  useEffect(() => {
    setEditValue(title);
    setIsEditing(false);
  }, [title, sessionId]);

  const handleSave = () => {
    if (sessionId && editValue.trim() && editValue.trim() !== title) {
      renameSession(sessionId, editValue.trim());
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      setEditValue(title);
      setIsEditing(false);
    }
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2">
      {isEditing ? (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="min-w-0 flex-1 bg-background border border-border/80 rounded px-1.5 py-0.5 text-[11px] font-semibold text-foreground/85 outline-none focus:ring-1 focus:ring-ring h-6"
          // biome-ignore lint/a11y/noAutofocus: autofocus is required for inline editing UX
          autoFocus
        />
      ) : (
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-left outline-none"
          onClick={() => sessionId && setIsEditing(true)}
          title={sessionId ? "Click to rename session" : undefined}
        >
          {sessionId && (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0 text-muted-foreground hover:text-foreground">
              <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={2} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground/80 px-1">
            {title}
          </span>
        </button>
      )}

      <div className="flex min-w-0 shrink-0 items-center justify-end gap-0.5">
        <button
          type="button"
          onClick={() => setPermissionMode("read-only")}
          className={cn(
            "flex shrink-0 items-center justify-center size-6 rounded-md",
            "transition-colors",
            permissionMode === "read-only"
              ? "bg-accent/60 text-foreground"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
          title="Read-only — deny all tool approvals automatically"
        >
          <HugeiconsIcon icon={ShieldUserIcon} size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setPermissionMode("default")}
          className={cn(
            "flex shrink-0 items-center justify-center size-6 rounded-md",
            "transition-colors",
            permissionMode === "default"
              ? "bg-accent/60 text-foreground"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
          title="Default — ask for approval on each tool"
        >
          <HugeiconsIcon icon={CheckListIcon} size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setPermissionMode("auto-approve")}
          className={cn(
            "flex shrink-0 items-center justify-center size-6 rounded-md",
            "transition-colors",
            permissionMode === "auto-approve"
              ? "bg-accent/60 text-foreground"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
          title="Auto-approve — approve all tool approvals automatically"
        >
          <HugeiconsIcon icon={FlashIcon} size={12} strokeWidth={2} />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border/50" />
        <button
          type="button"
          onClick={toggleHistory}
          className={cn(
            "flex shrink-0 items-center justify-center size-6 rounded-md",
            "transition-colors",
            historyOpen
              ? "bg-accent/60 text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          title={historyOpen ? "Back to chat" : "Chat history"}
          aria-pressed={historyOpen}
        >
          <HugeiconsIcon icon={Clock01Icon} size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={onNewSession}
          className={cn(
            "flex shrink-0 items-center justify-center size-6 rounded-md",
            "text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
          title="New chat"
        >
          <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

function estimateTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (p.type === "reasoning") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as unknown as { input?: unknown; output?: unknown };
        if (tp.input) chars += JSON.stringify(tp.input).length;
        if (tp.output) chars += JSON.stringify(tp.output).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function ContextIndicator({ messages }: { messages: UIMessage[] }) {
  const modelId = useChatStore(selectSelectedModelId);
  const tokens = useChatStore(selectAgentTokens);
  const lastInput = useChatStore(selectAgentLastInputTokens);
  const lastCached = useChatStore(selectAgentLastCachedTokens);
  const estimated = useMemo(() => estimateTokens(messages), [messages]);
  const used = lastInput > 0 ? lastInput : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  const openaiCompatibleContextLimit = usePreferencesStore(
    selectOpenaiCompatContextLimit,
  );
  const max = getModelContextLimit(modelId, openaiCompatibleContextLimit);
  const modelLabel = useMemo(() => {
    try {
      return getModel(modelId as ModelId).label;
    } catch {
      return modelId;
    }
  }, [modelId]);
  const cost = estimateCost(modelId, tokens);
  const cacheRate =
    tokens.inputTokens > 0
      ? Math.round((tokens.cachedInputTokens / tokens.inputTokens) * 100)
      : 0;

  return (
    <Context usedTokens={used} maxTokens={max} modelId={modelId}>
      <ContextTrigger className="h-6 shrink-0 gap-1 px-1.5 text-[10.5px]" />
      <ContextContent className="w-64 text-[11px]">
        <ContextContentHeader />
        <ContextContentBody>
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Model</span>
            <span className="font-mono text-foreground">{modelLabel}</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-muted-foreground">
            <span>{lastInput > 0 ? "Last request" : "Estimated context"}</span>
            <span className="font-mono text-foreground">
              {formatTokens(used)}
            </span>
          </div>
          {lastCached > 0 && (
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Of which cached</span>
              <span className="font-mono text-foreground">
                {formatTokens(lastCached)}
              </span>
            </div>
          )}
          {reported > 0 && (
            <>
              <div className="mt-1.5 flex items-center justify-between text-muted-foreground">
                <span>Session input</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.inputTokens)}
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Session output</span>
                <span className="font-mono text-foreground">
                  {formatTokens(tokens.outputTokens)}
                </span>
              </div>
              {tokens.cachedInputTokens > 0 && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Cache hit</span>
                  <span className="font-mono text-foreground">
                    {cacheRate}%
                  </span>
                </div>
              )}
              {cost != null && (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>Session cost</span>
                  <span className="font-mono text-foreground">
                    ${cost.toFixed(cost < 0.01 ? 4 : cost < 1 ? 3 : 2)}
                  </span>
                </div>
              )}
            </>
          )}
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Window</span>
            <span className="font-mono text-foreground">
              {formatTokens(max)}
            </span>
          </div>
        </ContextContentBody>
        <ContextContentFooter>
          <span className="text-[10px] italic text-muted-foreground">
            {lastInput > 0
              ? "Last request reflects current context size; session totals are cumulative."
              : "Token count is approximate (chars / 4)."}
          </span>
        </ContextContentFooter>
      </ContextContent>
    </Context>
  );
}

function relativeSessionTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function HistoryPanel({
  sessions,
  activeId,
  onSelect,
  onDelete,
  onNewSession,
}: {
  sessions: SessionMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewSession: () => void;
}) {
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background animate-in fade-in-0 duration-150">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-tight text-foreground/90">
            Chat history
          </p>
          <p className="text-[10.5px] text-muted-foreground">
            {sorted.length === 0
              ? "No conversations yet"
              : `${sorted.length} conversation${sorted.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={onNewSession}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1",
            "text-[11px] font-medium text-foreground",
            "bg-accent/50 transition-colors hover:bg-accent",
          )}
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
          New
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <HugeiconsIcon
            icon={Clock01Icon}
            size={22}
            strokeWidth={1.5}
            className="text-muted-foreground/50"
          />
          <p className="text-[12px] font-medium text-foreground/80">
            No chats yet
          </p>
          <p className="max-w-[14rem] text-[11px] leading-relaxed text-muted-foreground">
            Start a conversation and it will show up here.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-visible [scrollbar-gutter:stable] px-1.5 py-1.5">
          <ul className="flex flex-col gap-0.5">
            {sorted.map((s) => {
              const isActive = s.id === activeId;
              return (
                <li key={s.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 pr-8 text-left",
                      "transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      isActive
                        ? "bg-accent/55 text-foreground"
                        : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
                    )}
                  >
                    <span className="min-w-0 truncate text-[12px] font-medium text-foreground/90">
                      {s.title || "New chat"}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {relativeSessionTime(s.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.id);
                    }}
                    title="Delete chat"
                    className={cn(
                      "absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1",
                      "text-muted-foreground opacity-0 transition-opacity",
                      "hover:bg-destructive/10 hover:text-destructive",
                      "group-hover:opacity-100 focus-visible:opacity-100",
                      "outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    )}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center px-8 py-6 text-center overflow-y-auto scrollbar-visible min-h-0 w-full">
      <div className="my-auto flex flex-col items-center gap-6 w-full">
        <img src="/logo.png" alt="Xterax" className="size-14 opacity-90" />
        <div className="space-y-1.5">
          <p className="text-[14px] font-semibold tracking-tight">
            Ask Xterax anything
          </p>
          <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-muted-foreground">
            Xterax sees the active terminal — cwd, recent commands, and output.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => onPick(s.text)}
              className={cn(
                "group flex items-center gap-2.5 bg-card/70 rounded-lg px-2.5 py-2 border border-border text-left",
                "transition-colors hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/70 text-muted-foreground transition-colors group-hover:bg-foreground/5 group-hover:text-foreground">
                <HugeiconsIcon icon={s.icon} size={13} strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-foreground">
                  {s.label}
                </div>
                <div className="text-[10.5px] text-muted-foreground">
                  {s.hint}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
