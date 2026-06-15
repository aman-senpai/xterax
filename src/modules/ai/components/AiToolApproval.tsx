import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Edit02Icon,
  FileEditIcon,
  FilePlusIcon,
  FolderAddIcon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo, useEffect, useRef } from "react";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
  pendingCount?: number;
  onApproveAll?: () => void;
  onDenyAll?: () => void;
};

const TOOL_META: Record<string, { label: string; icon: typeof FilePlusIcon }> =
  {
    write_file: { label: "Write file", icon: FilePlusIcon },
    edit: { label: "Edit file", icon: FileEditIcon },
    multi_edit: { label: "Edit file (batch)", icon: Edit02Icon },
    create_directory: { label: "Create directory", icon: FolderAddIcon },
    bash_run: { label: "Run shell command", icon: TerminalIcon },
    bash_background: { label: "Spawn background process", icon: TerminalIcon },
  };

function AiToolApprovalImpl({
  part,
  toolName,
  onRespond,
  pendingCount,
  onApproveAll,
  onDenyAll,
}: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" || (isMeta && e.key.toLowerCase() === "y")) {
      e.preventDefault();
      onRespond(true);
    } else if (
      e.key === "Escape" ||
      (isMeta && e.key.toLowerCase() === "n")
    ) {
      e.preventDefault();
      onRespond(false);
    }
  };

  return (
    <div
      ref={cardRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "rounded-lg border border-border bg-card shadow-sm",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {pendingCount != null && pendingCount > 1 && onApproveAll && onDenyAll ? (
        <div className="flex items-center justify-end gap-2.5 border-b border-border/40 px-3 py-1">
          <button
            type="button"
            onClick={onDenyAll}
            className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Deny All ({pendingCount})
          </button>
          <button
            type="button"
            onClick={onApproveAll}
            className="text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Approve All ({pendingCount})
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 animate-pulse" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} />
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // The approval card never changes content for a given approvalId — once
  // the model has emitted the approval-requested part with its input, we
  // don't want to re-render on every downstream token.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.onRespond === b.onRespond &&
    a.pendingCount === b.pendingCount &&
    a.onApproveAll === b.onApproveAll &&
    a.onDenyAll === b.onDenyAll
  );
});

function PreviewBlock({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {cwd}
          </div>
        )}
        <pre
          className={cn(
            "max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed",
          )}
        >
          {String(input.command ?? "")}
        </pre>
      </div>
    );
  }

  if (toolName === "write_file") {
    const content = typeof input.content === "string" ? input.content : "";
    const lines = content ? content.split("\n").length : 0;
    const previewLines = content ? content.split("\n").slice(0, 15) : [];
    const remaining = lines - 15;
    return (
      <div className="space-y-1 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        {content ? (
          <>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed">
              {previewLines.join("\n")}
            </pre>
            {remaining > 0 ? (
              <div className="text-[10.5px] text-muted-foreground/80">
                ... {remaining} more line{remaining === 1 ? "" : "s"}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  if (toolName === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    return (
      <div className="space-y-1 font-mono text-[11px]">
        <div className="text-muted-foreground">
          {String(input.path ?? "")}
          {input.replace_all ? " · replace all" : ""}
        </div>
        <DiffBlock oldStr={oldStr} newStr={newStr} />
      </div>
    );
  }

  if (toolName === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ old_string?: string; new_string?: string }>)
      : [];
    return (
      <div className="space-y-1 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        {edits.length > 0 ? (
          <div className="max-h-[120px] space-y-0.5 overflow-auto rounded-md bg-muted/60 p-2">
            {edits.map((edit, i) => (
              <div key={i}>
                {i > 0 ? (
                  <div className="mb-0.5 border-t border-border/30" />
                ) : null}
                {edit.old_string != null || edit.new_string != null ? (
                  <DiffBlock
                    oldStr={edit.old_string ?? ""}
                    newStr={edit.new_string ?? ""}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (toolName === "create_directory") {
    return (
      <div className="font-mono text-[11px] text-muted-foreground">
        {String(input.path ?? "")}
      </div>
    );
  }

  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function DiffBlock({
  oldStr,
  newStr,
}: {
  oldStr: string;
  newStr: string;
}) {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  const lines: Array<{ kind: "removed" | "added"; text: string }> = [];

  for (const line of oldLines) {
    lines.push({ kind: "removed", text: line });
  }
  for (const line of newLines) {
    lines.push({ kind: "added", text: line });
  }

  if (lines.length === 0) return null;

  return (
    <div className="max-h-[120px] overflow-auto rounded-md bg-muted/60 p-2">
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "whitespace-pre text-[11px] leading-relaxed",
            line.kind === "removed" &&
              "bg-destructive/15 text-destructive",
            line.kind === "added" &&
              "bg-emerald-500/15 text-emerald-600",
          )}
        >
          {line.kind === "removed" ? "- " : "+ "}
          {line.text}
        </div>
      ))}
    </div>
  );
}
