import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  BrainIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  getModel,
  isCompatModelId,
  type ModelId,
  type ProviderId,
} from "../config";
import { getThinkingLevels, supportsThinkingLevel } from "../lib/thinking";
import { useChatStore } from "../store/chatStore";

export function ThinkingModeDropdown({
  compact = false,
}: {
  compact?: boolean;
}) {
  const selectedModelId = useChatStore((s) => s.selectedModelId);
  const level = useChatStore((s) => s.thinkingLevel);
  const setLevel = useChatStore((s) => s.setThinkingLevel);

  let provider: ProviderId;
  try {
    provider = isCompatModelId(selectedModelId)
      ? "openai-compatible"
      : getModel(selectedModelId as ModelId).provider;
  } catch {
    provider = "openai-compatible";
  }

  const canThink = supportsThinkingLevel(provider);
  const levels = getThinkingLevels(provider);
  const current = levels.find((l) => l.value === level) ?? levels[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-xs" : "sm"}
          disabled={!canThink}
          className={cn(
            "shrink-0 rounded-md hover:bg-accent hover:text-foreground",
            compact
              ? "size-6"
              : "my-1 h-5.5 min-w-0 gap-1 overflow-hidden px-1.5 text-xs",
            canThink
              ? level === "off"
                ? "text-muted-foreground/50"
                : "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground/30",
          )}
          title={
            canThink
              ? `Thinking: ${current.label}`
              : "Thinking mode not supported for this provider"
          }
        >
          <HugeiconsIcon
            icon={BrainIcon}
            size={12}
            strokeWidth={1.5}
            className="shrink-0 text-muted-foreground/70"
          />
          {!compact ? (
            <>
              <span className="min-w-0 truncate">{current.label}</span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="shrink-0 opacity-70"
              />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-40 p-0 overflow-hidden rounded-xl border border-border/70 shadow-xl"
      >
        <div className="max-h-60 overflow-y-auto py-1">
          {levels.map((l) => {
            const active = l.value === level;
            return (
              <DropdownMenuItem
                key={l.value}
                onSelect={(e) => {
                  e.preventDefault();
                  setLevel(l.value);
                }}
                className={cn(
                  "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                  active
                    ? "bg-accent/60 text-foreground"
                    : "text-foreground/85",
                )}
              >
                <span className="text-[12px] font-medium leading-none">
                  {l.label}
                </span>
                <span className="flex-1" />
                <HugeiconsIcon
                  icon={Tick01Icon}
                  size={13}
                  strokeWidth={2}
                  className={cn(
                    "text-foreground transition-opacity",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
