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
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  CheckListIcon,
  Delete02Icon,
  FilterIcon,
  FlashIcon,
  ShieldUserIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef } from "react";
import { estimateCost, getModel, getModelContextLimit, type ModelId } from "../config";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import type { SessionMeta } from "../lib/sessions";
import { useChatStore } from "../store/chatStore";
import { getOrCreateChat } from "../store/chatRuntime";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { usePlanStore } from "../store/planStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { AiChatView } from "./AiChat";
import { AiComposerInput } from "./AiComposerInput";
import { ModelDropdown } from "./AiStatusBarControls";
import { ThinkingModeDropdown } from "./ThinkingModeDropdown";
import { PlanDiffReview } from "./PlanDiffReview";
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

export function RightPanel() {
  const closeRightPanel = useChatStore((s) => s.closeRightPanel);
  const sessionId = useChatStore((s) => s.activeSessionId);

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
      {sessionId ? (
        <Body sessionId={sessionId} />
      ) : (
        <EmptyShell />
      )}
      <PlanDiffReview />
    </div>
  );
}

function Body({ sessionId }: { sessionId: string }) {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusInput = useChatStore((s) => s.focusInput);
  const step = useChatStore((s) => s.agentMeta.step);
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const newSession = useChatStore((s) => s.newSession);
  const switchSession = useChatStore((s) => s.switchSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const historyOpen = useChatStore((s) => s.historyOpen);
  const toggleHistory = useChatStore((s) => s.toggleHistory);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  const isBusy =
    helpers.status === "submitted" || helpers.status === "streaming";

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const activeTitle = active?.title || "New chat";

  return (
    <>
      <Header
        step={step}
        isBusy={isBusy}
        title={activeTitle}
        onNewSession={() => {
          newSession();
          toggleHistory();
        }}
      />

      {historyOpen ? (
        <HistoryPanel
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => {
            switchSession(id);
            toggleHistory();
          }}
          onDelete={deleteSession}
        />
      ) : null}

      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {helpers.messages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12px] [&_p]:leading-relaxed">
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

      {/* AI Composer Input — moved from WorkspaceInputBar */}
      <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
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
        <AiComposerInput />
        <div className="mt-1.5 flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Attach file or image"
              onClick={() => fileInputRef.current?.click()}
              disabled={c.isBusy}
              className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
            </Button>
            <ContextIndicator messages={helpers.messages} />
            <AgentSwitcher />
          </div>
          <div className="flex min-w-0 items-center gap-1 ml-auto">
            <ThinkingModeDropdown />
            <ModelDropdown />
          </div>
        </div>
      </div>
    </>
  );
}

function PlanModeStrip() {
  const active = usePlanStore((s) => s.active);
  const queueLen = usePlanStore((s) => s.queue.length);
  const disable = usePlanStore((s) => s.disable);
  if (!active) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-muted/40 px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="text-[11px] font-medium text-foreground">Plan mode</span>
      <span className="text-[11px] text-muted-foreground">
        {queueLen > 0 ? `· ${queueLen} queued` : "· no edits queued"}
      </span>
      <span className="flex-1" />
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

function EmptyShell() {
  return (
    <>
      <Header
        step={null}
        isBusy={false}
        title="Loading…"
        onNewSession={() => {}}
      />
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
        Loading sessions…
      </div>
    </>
  );
}

function Header({
  step,
  isBusy,
  title,
  onNewSession,
}: {
  step: string | null;
  isBusy: boolean;
  title: string;
  onNewSession: () => void;
}) {
  const historyOpen = useChatStore((s) => s.historyOpen);
  const toggleHistory = useChatStore((s) => s.toggleHistory);
  const permissionMode = useChatStore((s) => s.permissionMode);
  const setPermissionMode = useChatStore((s) => s.setPermissionMode);

  return (
    <div className="relative flex h-8 shrink-0 items-center gap-2 border-b border-border/60 px-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {isBusy ? (
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Spinner className="size-2.5" />
            <span className="max-w-32 truncate">{step ?? "Thinking…"}</span>
          </span>
        ) : null}
      </div>

      <span className="absolute left-1/2 -translate-x-1/2 max-w-48 truncate text-[11px] text-muted-foreground pointer-events-none">
        {title}
      </span>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-0.5">
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
            "text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
          )}
          title="Session history"
        >
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className={cn(
              "transition-transform",
              historyOpen && "rotate-180",
            )}
          />
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
  const modelId = useChatStore((s) => s.selectedModelId);
  const tokens = useChatStore((s) => s.agentMeta.tokens);
  const lastInput = useChatStore((s) => s.agentMeta.lastInputTokens);
  const lastCached = useChatStore((s) => s.agentMeta.lastCachedTokens);
  const estimated = useMemo(() => estimateTokens(messages), [messages]);
  const used = lastInput > 0 ? lastInput : estimated;
  const reported = tokens.inputTokens + tokens.outputTokens;
  const openaiCompatibleContextLimit = usePreferencesStore(
    (s) => s.openaiCompatibleContextLimit,
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
      <ContextTrigger className="h-6 gap-1 px-0 text-[10.5px]" />
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
                  <span className="font-mono text-foreground">{cacheRate}%</span>
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

function HistoryPanel({
  sessions,
  activeId,
  onSelect,
  onDelete,
}: {
  sessions: SessionMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="max-h-[40vh] shrink-0 overflow-y-auto scrollbar-visible [scrollbar-gutter:stable] border-b border-border/60 bg-muted/30 animate-in slide-in-from-top-1 duration-150">
        {sorted.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={cn(
              "group flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left",
              "text-[11px] transition-colors hover:bg-accent/40",
              s.id === activeId
                ? "bg-accent/40 text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span className="min-w-0 flex-1 truncate">
              {s.title || "New chat"}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              title="Delete session"
              className={cn(
                "rounded p-0.5 text-muted-foreground opacity-0 transition-opacity",
                "hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100",
              )}
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            </button>
          </button>
        ))}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-10 text-center">
      <img src="/logo.png" alt="Terax" className="size-14 opacity-90" />
      <div className="space-y-1.5">
        <p className="text-[14px] font-semibold tracking-tight">
          Ask Terax anything
        </p>
        <p className="max-w-[18rem] text-[11.5px] leading-relaxed text-muted-foreground">
          Terax sees the active terminal — cwd, recent commands, and output.
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
  );
}
