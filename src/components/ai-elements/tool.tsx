"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CheckListIcon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import {
  getSubagentState,
  getCurrentBatch,
  subscribeSubagentProgress,
  getProgressVersion,
  resolveApproval,
} from "@/modules/ai/agents/subagentProgress";
import { AiToolApproval } from "@/modules/ai/components/AiToolApproval";
import { TodoWriteCard } from "@/modules/ai/components/TodoList";
import { todosFingerprint } from "@/modules/ai/lib/todos";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { Streamdown } from "streamdown";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useEffect, useSyncExternalStore, useState } from "react";
import { ChatStreamingProvider } from "./chat-code";
import { MarkdownCode } from "./markdown-code";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "./reasoning";


export type ToolPart = ToolUIPart | DynamicToolUIPart;

const TOOL_META: Record<string, { label: string; icon: typeof File01Icon }> = {
  read_file: { label: "Read", icon: File01Icon },
  list_directory: { label: "List", icon: FolderOpenIcon },
  write_file: { label: "Write", icon: FilePlusIcon },
  create_directory: { label: "Create dir", icon: FolderAddIcon },
  edit: { label: "Edit", icon: FileEditIcon },
  multi_edit: { label: "Edit", icon: Edit02Icon },
  bash_run: { label: "Run", icon: TerminalIcon },
  bash_background: { label: "Spawn", icon: TerminalIcon },
  bash_logs: { label: "Logs", icon: TerminalIcon },
  bash_list: { label: "Jobs", icon: TerminalIcon },
  bash_kill: { label: "Kill", icon: TerminalIcon },
  grep: { label: "Search", icon: GlobalSearchIcon },
  glob: { label: "Glob", icon: Folder01Icon },
  suggest_command: { label: "Suggest", icon: SparklesIcon },
  open_preview: { label: "Preview", icon: EyeIcon },
  run_subagent: { label: "Subagents", icon: RobotIcon },
  todo_write: { label: "Todos", icon: CheckListIcon },
};

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function subagentLabel(desc?: string): string {
  return desc ?? "Working";
}

function formatPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.split(/[/\\]/);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function formatCommand(cmd: string | null | undefined): string | null {
  if (!cmd) return null;
  const firstLine = cmd.split("\n")[0].trim();
  return firstLine.length > 40 ? firstLine.slice(0, 37) + "..." : firstLine;
}

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
      return formatPath(str("path"));
    case "bash_run":
    case "bash_background":
      return formatCommand(str("command"));
    case "bash_logs":
    case "bash_kill":
      return str("id");
    case "grep":
      return str("pattern") ?? str("query");
    case "glob":
      return str("pattern");
    case "suggest_command":
      return str("intent") ?? str("description");
    case "open_preview":
      return str("path") ?? str("url");
    case "run_subagent": {
      const tasks = Array.isArray(i.tasks) ? i.tasks : [];
      if (tasks.length === 0) return "no tasks";
      return `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
    }
    case "todo_write": {
      const items = Array.isArray(i.todos) ? i.todos : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    }
    default:
      return null;
  }
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` carries large/streaming content (file bodies).
// The AI diff tab is the canonical place to view file changes; header
// summary + final output is enough. Re-rendering streamed input on every
// token both stalls the UI and duplicates information.
// todo_write is handled separately via TodoWriteCard (not heavy).
const HEAVY_CONTENT_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
]);

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  const label = meta?.label ?? toolName;
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  const open = defaultOpen ?? isError;
  const isHeavy = HEAVY_CONTENT_TOOLS.has(toolName);
  // For heavy tools, only show details on error — never the streamed input
  // body, which is huge and re-renders per token.
  const showInputBody = !isHeavy && Boolean(input);
  const showOutputBody = !isHeavy && output !== undefined;
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

  // Subagents render as standalone task cards — no collapsible wrapper.
  if (toolName === "run_subagent") {
    return <SubagentCards input={input} output={output} state={state} />;
  }

  // Todos: compact chip while active (live list is TodoStrip); full
  // checklist in-thread once every item is completed so the strip can detach.
  if (toolName === "todo_write") {
    return <TodoWriteCard input={input} state={state} />;
  }

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn("xterax-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput toolName={toolName} input={input} />
            ) : null}
            {showOutputBody || errorText ? (
              <ToolOutput
                toolName={toolName}
                output={showOutputBody ? output : undefined}
                errorText={errorText}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing — NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
/** Shared streamdown components — same markdown rendering as main chat. */
const streamdownComponents = { code: MarkdownCode };

/** Map subagent step state → ToolPart state so the real <Tool /> component
 *  renders subagent tool calls with identical visual design. */
function stepStateToToolState(s: string): ToolPart["state"] {
  switch (s) {
    case "pending": return "input-available";
    case "awaiting-approval": return "approval-requested";
    case "done": return "output-available";
    case "denied": return "output-denied";
    case "error": return "output-error";
    default: return "input-available";
  }
}

/** Thin wrapper around <AiToolApproval /> for subagent steps that await approval. */
function SubagentApprovalTool({
  step,
  jobId,
  stepIndex,
}: {
  step: NonNullable<Parameters<typeof SubagentCard>[0]["steps"]>[number];
  jobId: string;
  stepIndex: number;
}) {
  "use no memo";
  return (
    <div className="my-1.5">
      <AiToolApproval
        part={{
          type: "tool-call",
          state: "approval-requested",
          approval: { id: `${jobId}-${stepIndex}` },
          input: step.input as Record<string, unknown>,
          toolCallId: `${jobId}-${stepIndex}`,
          toolName: step.toolName,
        } as any}
        toolName={step.toolName}
        onRespond={(approved) => resolveApproval(jobId, stepIndex, approved)}
      />
    </div>
  );
}

// SubagentCard receives progress store objects mutated in place (steps array,
// reasoning string appended via +=). The React Compiler sees identical object
// references and skips re-renders even when the internal state has changed.
function SubagentCard({
  description,
  status,
  text,
  reasoning,
  steps,
  durationMs,
  error,
  jobId,
  prompt,
}: {
  description: string;
  status: string;
  text?: string;
  reasoning?: string;
  steps?: Array<{
    toolName: string;
    input: unknown;
    output?: unknown;
    state: string;
    errorText?: string;
  }>;
  pendingApprovals?: Array<{
    stepIndex: number;
    toolName: string;
    input: unknown;
  }>;
  durationMs?: number;
  error?: string;
  jobId?: string;
  prompt?: string;
}) {
  "use no memo";
  const isRunning = status === "running";
  const isDone = status === "done";
  const hasActivity =
    (reasoning && reasoning.length > 0) ||
    (steps && steps.length > 0) ||
    (text && text.length > 0);
  const hasPendingApproval = steps?.some((s) => s.state === "awaiting-approval");
  const [open, setOpen] = useState(hasPendingApproval || !!error);

  useEffect(() => {
    if (hasPendingApproval || error) setOpen(true);
  }, [hasPendingApproval, error]);

  return (
    <div>
      {/* Header — matches tool card trigger styling */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={!hasActivity && !isRunning}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        {isRunning ? (
          <Spinner className="size-1.5 shrink-0" />
        ) : (
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              isDone ? "bg-emerald-500" : "bg-destructive",
            )}
          />
        )}
        <HugeiconsIcon
          icon={RobotIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {description}
        </span>
        {/* Latest tool call indicator — visible even when collapsed */}
        {steps && steps.length > 0 ? (
          <span className="hidden min-w-0 max-w-40 shrink-0 truncate font-mono text-[10px] text-muted-foreground sm:block">
            → {toolDisplayName(steps[steps.length - 1].toolName)}
            {toolInputSummary(
              steps[steps.length - 1].toolName,
              steps[steps.length - 1].input,
            )
              ? " · " + toolInputSummary(
                  steps[steps.length - 1].toolName,
                  steps[steps.length - 1].input,
                )
              : null}
          </span>
        ) : null}
        {isDone && durationMs != null ? (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {(durationMs / 1000).toFixed(1)}s
          </span>
        ) : null}
        {error ? (
          <span className="shrink-0 text-[10px] font-medium text-destructive">error</span>
        ) : null}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {/* Expanded content — indented with border-l, matching tool card content */}
      {open ? (
        <div className="ml-3 space-y-2 border-l border-border/60 pb-1 pl-3">
          {/* Error */}
          {error ? (
            <div className="flex items-center gap-1.5 rounded bg-destructive/10 px-2 py-1 text-[10.5px] text-destructive">
              <span className="size-1 shrink-0 rounded-full bg-destructive" />
              {error}
            </div>
          ) : null}

          {/* Task prompt */}
          {prompt ? (
            <div className="rounded-2xl rounded-br-sm bg-muted/70 px-3 py-2 text-[12px] leading-relaxed text-foreground whitespace-pre-wrap">
              {prompt.length > 300 ? prompt.slice(0, 300) + "…" : prompt}
            </div>
          ) : null}

          {/* Reasoning — same compound component as main chat */}
          {reasoning ? (
            <Reasoning isStreaming={isRunning} defaultOpen={false}>
              <ReasoningTrigger />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          ) : null}

          {/* Tool calls — reuse the real <Tool /> component from main chat */}
          {steps?.map((s, si) =>
            s.state === "awaiting-approval" && jobId ? (
              <SubagentApprovalTool
                key={si}
                step={s}
                jobId={jobId}
                stepIndex={si}
              />
            ) : (
              <Tool
                key={si}
                toolName={s.toolName}
                state={stepStateToToolState(s.state)}
                input={s.input}
                output={s.output}
                errorText={s.errorText}
              />
            ),
          )}

          {/* Text output — rendered as markdown via Streamdown */}
          {text ? (
            <ChatStreamingProvider value={isRunning}>
              <Streamdown
                className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                components={streamdownComponents}
              >
                {text}
              </Streamdown>
            </ChatStreamingProvider>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Human-readable label for tool names. */
function toolDisplayName(name: string): string {
  const labels: Record<string, string> = {
    read_file: "Read", list_directory: "List", write_file: "Write",
    create_directory: "Create dir", edit: "Edit", multi_edit: "Edit batch",
    grep: "Search", glob: "Glob", bash_run: "Run", bash_background: "Spawn",
    bash_logs: "Logs", bash_list: "Jobs", bash_kill: "Kill",
    suggest_command: "Suggest", open_preview: "Preview",
  };
  return labels[name] ?? name;
}

/** Compact input summary for tool call display. */
function toolInputSummary(
  toolName: string,
  input: unknown,
): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? i[k] as string : "");
  switch (toolName) {
    case "write_file":
    case "read_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
      return formatPath(s("path")) ?? "";
    case "bash_run":
    case "bash_background":
      return formatCommand(s("command")) ?? "";
    case "grep":
      return s("pattern") ?? s("query");
    case "glob":
      return s("pattern");
    default:
      return "";
  }
}

// SubagentCards depends on useSyncExternalStore whose subscription lives
// outside React's prop-diffing. The React Compiler must not memoize this
// component — it would treat every render as a no-op when props are stable
// and skip re-renders triggered by external store changes.
function SubagentCards({
  input,
  output,
  state,
}: {
  input: unknown;
  output: unknown;
  state: ToolPart["state"];
}) {
  "use no memo";
  // React reads the snapshot during render and re-checks it after
  // subscribing during commit. If the store changed in between, React
  // re-renders immediately — no progress events are missed.
  useSyncExternalStore(
    (cb) => subscribeSubagentProgress(cb),
    getProgressVersion,
  );

  const tasks = (
    input && typeof input === "object"
      ? (input as Record<string, unknown>).tasks
      : null
  ) as Array<{ description?: string; prompt?: string }> | null;

  const results = (
    output && typeof output === "object"
      ? (output as Record<string, unknown>).results
      : null
  ) as Array<{
    description?: string;
    status?: string;
    summary?: string;
    stepCount?: number;
    durationMs?: number;
    error?: string;
  }> | null;

  const isRunning =
    state === "input-streaming" ||
    state === "input-available" ||
    (results == null && state !== "output-error");

  // During execution, try to get live streaming progress for each task.
  if (isRunning && tasks && tasks.length > 0) {
    const batch = getCurrentBatch();

    // Count completed subagents by checking progress store statuses.
    const { done, total } = batch.reduce(
      (acc, job) => {
        const s = job ? getSubagentState(job.jobId) : null;
        acc.total++;
        if (s?.status === "done" || s?.status === "error") acc.done++;
        return acc;
      },
      { done: 0, total: 0 },
    );

    const progressWidth = total > 0 ? (done / total) * 100 : 0;

    return (
      <div className="space-y-0.5">
        {/* Progress bar */}
        {total > 0 ? (
          <div className="flex items-center gap-2 px-0.5 pb-0.5">
            <div className="flex-1 h-1 rounded-full bg-muted/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500/60 transition-all duration-300"
                style={{ width: `${progressWidth}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] font-mono text-muted-foreground tabular-nums">
              {done}/{total}
            </span>
          </div>
        ) : null}
        {tasks.map((t, i) => {
          const job = batch[i];
          const prog = job ? getSubagentState(job.jobId) : null;

          return (
            <SubagentCard
              key={i}
              description={t.description || `Task ${i + 1}`}
              status={prog?.status ?? "running"}
              text={prog?.text}
              reasoning={prog?.reasoning}
              steps={prog?.steps}
              error={prog?.error}
              jobId={job?.jobId}
              prompt={t.prompt}
            />
          );
        })}
      </div>
    );
  }

  // Error state.
  if (state === "output-error" && !results) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
        <span className="text-[11px] text-destructive">Subagent error</span>
      </div>
    );
  }

  // Results — keep showing progress-store data alongside final output.
  if (results && results.length > 0) {
    const batch = getCurrentBatch();
    return (
      <div className="space-y-0.5">
        {results.map((r, i) => {
          const job = batch[i];
          const prog = job ? getSubagentState(job.jobId) : null;
          return (
            <SubagentCard
              key={i}
              description={r.description || `Task ${i + 1}`}
              status={r.status ?? "done"}
              text={r.summary}
              steps={prog?.steps}
              reasoning={prog?.reasoning}
              durationMs={r.durationMs}
              error={r.error}
              jobId={job?.jobId}
              prompt={tasks?.[i]?.prompt}
            />
          );
        })}
      </div>
    );
  }

  return null;
}

export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (a.toolName === "todo_write") {
    return todosFingerprint(a.input) === todosFingerprint(b.input);
  }
  if (HEAVY_CONTENT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          Input
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Input</div>
      <CodeBlockMini
        code={
          typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
        language="json"
      />
    </div>
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "run_subagent") {
    const tasks = Array.isArray(i.tasks) ? i.tasks : [];
    if (tasks.length === 0) return null;
    return (
      <div className="space-y-1.5">
        {tasks.map((t: { description?: string; prompt?: string }, idx: number) => (
          <div key={idx} className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5">
            <Spinner className="size-3 shrink-0" />
            <HugeiconsIcon
              icon={RobotIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="text-[11px] text-foreground/80 truncate">
              {t.description || `Task ${idx + 1}`}
            </span>
          </div>
        ))}
      </div>
    );
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "run_subagent") {
    const results = Array.isArray(o.results) ? o.results : [];
    if (results.length === 0) return null;

    return (
      <div className="space-y-0.5">
        {results.map(
          (
            r: {
              description?: string;
              status?: string;
              summary?: string;
              stepCount?: number;
              durationMs?: number;
              error?: string;
            },
            i: number,
          ) => (
            <div key={i}>
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    r.status === "done"
                      ? "bg-emerald-500"
                      : "bg-destructive",
                  )}
                />
                <HugeiconsIcon
                  icon={RobotIcon}
                  size={13}
                  strokeWidth={1.75}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {subagentLabel(r.description)}
                </span>
                {r.status === "done" && r.durationMs != null ? (
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {(r.durationMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
                {r.status === "done" && r.stepCount != null ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    · {r.stepCount} step{r.stepCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              {r.error ? (
                <div className="ml-3 border-l border-border/60 pl-3 pb-1">
                  <div className="flex items-center gap-1.5 rounded bg-destructive/10 px-2 py-1 text-[10.5px] text-destructive">
                    <span className="size-1 shrink-0 rounded-full bg-destructive" />
                    {r.error}
                  </div>
                </div>
              ) : null}
              {r.status === "done" && r.summary ? (
                <div className="ml-3 border-l border-border/60 pl-3 pb-1">
                  <Streamdown
                    className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                    components={streamdownComponents}
                  >
                    {r.summary}
                  </Streamdown>
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>
    );
  }

  if (toolName === "read_subagent_results") {
    // Legacy — this tool is no longer used (run_subagent blocks internally).
    // Keep the handler for historical tool calls that may still be in messages.
    const results = Array.isArray(o.results) ? o.results : [];
    if (results.length === 0) return null;
    return (
      <div className="space-y-0.5">
        {results.map((r: { description?: string; status?: string; summary?: string; error?: string }, i: number) => (
          <div key={i}>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", r.status === "done" ? "bg-emerald-500" : "bg-destructive")} />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">{r.description ?? "Subagent"}</span>
            </div>
            {r.summary ? (
              <div className="ml-3 border-l border-border/60 pl-3 pb-1">
                <Streamdown
                  className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                  components={streamdownComponents}
                >
                  {r.summary}
                </Streamdown>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    if (!cmd) return null;
    return <SuggestCommandCard command={cmd} explanation={explanation} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? (
          <div className="truncate text-muted-foreground">{cmd}</div>
        ) : null}
      </div>
    );
  }

  return null;
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail — JSON arrives pre-formatted and
  // file content is shown in the editor diff tab. Highlighting here is not
  // worth the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function SuggestCommandCard({
  command,
  explanation,
}: {
  command: string;
  explanation: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore
      .getState()
      .live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };
