import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AcpAgentConfig } from "@/modules/acp/types";
import type { SkillConfig } from "@/modules/skills/types";
import {
  File02Icon,
  RobotIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef } from "react";
import type { Agent } from "../lib/agents";
import type { PipelineLoopPreset } from "../lib/pipelineDsl";
import type { SlashCommandMeta } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";

export type PickerItem =
  | { kind: "snippet"; snippet: Snippet }
  | { kind: "loop"; preset: PipelineLoopPreset }
  | { kind: "command"; command: SlashCommandMeta }
  | { kind: "skill"; skill: SkillConfig }
  | { kind: "agent"; agent: Agent }
  | { kind: "acp"; config: AcpAgentConfig; handle: string }
  | { kind: "file"; filePath: string };

type Props = {
  items: readonly PickerItem[];
  activeIndex: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
};

function sectionLabel(kind: PickerItem["kind"]): string {
  switch (kind) {
    case "agent":
      return "Agents";
    case "acp":
      return "External (ACP)";
    case "file":
      return "Files";
    case "command":
      return "Commands";
    case "skill":
      return "Skills";
    case "snippet":
      return "Snippets";
    case "loop":
      return "Loops";
  }
}

/**
 * Renders items in array order (so keyboard activeIndex matches pick order)
 * with section headers when the kind changes. Scrolls the active row into view.
 */
export function SnippetPickerContent({
  items,
  activeIndex,
  onPick,
  onHover,
}: Props) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items.length]);

  // Group consecutive same-kind items for section headers while keeping order.
  const rows: Array<
    | { type: "header"; label: string; key: string }
    | { type: "item"; item: PickerItem; index: number }
  > = [];
  let prevKind: PickerItem["kind"] | null = null;
  items.forEach((item, index) => {
    if (item.kind !== prevKind) {
      rows.push({
        type: "header",
        label: sectionLabel(item.kind),
        key: `h-${item.kind}-${index}`,
      });
      prevKind = item.kind;
    }
    rows.push({ type: "item", item, index });
  });

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="w-72 overflow-hidden rounded-lg border border-border/60 bg-popover/95 p-0 shadow-xl backdrop-blur-xl"
    >
      {items.length === 0 ? (
        <div className="px-3 py-2.5 text-[11px] text-muted-foreground">
          No matches.
        </div>
      ) : (
        <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
          {rows.map((row) => {
            if (row.type === "header") {
              return <SectionHeader key={row.key} label={row.label} />;
            }
            const { item, index: i } = row;
            const active = i === activeIndex;
            return (
              <div key={itemKey(item, i)}>
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(item)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                    active ? "bg-accent" : "hover:bg-accent/60",
                  )}
                >
                  <PickerRow item={item} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </PopoverContent>
  );
}

function itemKey(item: PickerItem, index: number): string {
  switch (item.kind) {
    case "agent":
      return `agent-${item.agent.id}`;
    case "acp":
      return `acp-${item.config.id}`;
    case "file":
      return `file-${item.filePath}`;
    case "command":
      return `cmd-${item.command.name}`;
    case "skill":
      return `skill-${item.skill.id}`;
    case "snippet":
      return `sn-${item.snippet.id}`;
    case "loop":
      return `loop-${item.preset.id}`;
    default:
      return `i-${index}`;
  }
}

function PickerRow({ item }: { item: PickerItem }) {
  if (item.kind === "file") {
    const fileName = item.filePath.split("/").pop() || item.filePath;
    return (
      <>
        <HugeiconsIcon
          icon={File02Icon}
          size={13}
          strokeWidth={1.5}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[12px]">{fileName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground/60">
          {item.filePath}
        </span>
      </>
    );
  }

  if (item.kind === "agent") {
    const a = item.agent;
    return (
      <>
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted/40">
          <HugeiconsIcon
            icon={SparklesIcon}
            size={11}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">@{a.handle}</span>
            <span className="font-medium">{a.name}</span>
          </span>
          {a.description ? (
            <span className="line-clamp-1 text-[10px] text-muted-foreground">
              {a.description}
            </span>
          ) : null}
        </span>
        {a.builtIn && (
          <span className="rounded bg-muted/50 px-1 py-px text-[9px] text-muted-foreground">
            BUILT-IN
          </span>
        )}
      </>
    );
  }

  if (item.kind === "acp") {
    const { config, handle } = item;
    return (
      <>
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-sky-500/15">
          <HugeiconsIcon
            icon={RobotIcon}
            size={11}
            strokeWidth={1.5}
            className="text-sky-600 dark:text-sky-400"
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">@{handle}</span>
            <span className="font-medium">{config.name}</span>
          </span>
          <span className="line-clamp-1 font-mono text-[10px] text-muted-foreground">
            {config.command}
            {config.args.length ? ` ${config.args.join(" ")}` : ""}
          </span>
        </span>
        <span className="rounded bg-sky-500/15 px-1 py-px text-[9px] text-sky-600 dark:text-sky-400">
          ACP
        </span>
      </>
    );
  }

  if (item.kind === "command") {
    const c = item.command;
    return (
      <>
        <HugeiconsIcon
          icon={c.icon}
          size={13}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-muted-foreground">/{c.name}</span>
            <span className="font-medium">{c.label}</span>
          </span>
        </span>
      </>
    );
  }

  if (item.kind === "skill") {
    const s = item.skill;
    return (
      <span className="flex w-full flex-col items-start gap-0.5">
        <span className="flex w-full items-center gap-1.5">
          <span className="font-mono text-muted-foreground">/{s.name}</span>
          <span className="font-medium">{s.name}</span>
        </span>
        {s.description ? (
          <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
            {s.description}
          </span>
        ) : null}
      </span>
    );
  }

  if (item.kind === "loop") {
    const p = item.preset;
    return (
      <span className="flex w-full flex-col items-start gap-0.5">
        <span className="flex w-full items-center gap-1.5">
          <span className="font-mono text-muted-foreground">#{p.handle}</span>
          <span className="font-medium">{p.name}</span>
          <span className="rounded bg-violet-500/15 px-1 py-px text-[9px] text-violet-600 dark:text-violet-400">
            loop {p.max}
          </span>
        </span>
        {p.description ? (
          <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
            {p.description}
          </span>
        ) : null}
      </span>
    );
  }

  // snippet
  const s = item.snippet;
  return (
    <span className="flex w-full flex-col items-start gap-0.5">
      <span className="flex w-full items-center gap-1.5">
        <span className="font-mono text-muted-foreground">#{s.handle}</span>
        <span className="font-medium">{s.name}</span>
      </span>
      {s.description ? (
        <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
          {s.description}
        </span>
      ) : null}
    </span>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground/70 uppercase">
      {label}
    </div>
  );
}
