import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  isOptionSelected,
  MODEL_THOUGHT_OPTION_ID,
  modelIdAfterThoughtChange,
  optionCurrentLabel,
  slotConfigOptions,
  type ThoughtLevel,
  useAcpStore,
  type AcpConfigOption,
} from "@/modules/acp";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowDown01Icon,
  BrainIcon,
  FlashIcon,
  SparklesIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";

/**
 * Composer toolbar controls for ACP sessions.
 * Mirrors local ThinkingModeDropdown + ModelDropdown layout:
 *   mode (label) · thinking (brain icon) · model (label)
 * Values come from agent configOptions / legacy modes.
 */
export function AcpSessionControls({ sessionId }: { sessionId: string }) {
  const binding = useAcpStore((s) => s.bindings[sessionId]);
  const setMode = useAcpStore((s) => s.setMode);
  const setConfigOption = useAcpStore((s) => s.setConfigOption);
  const [bootError, setBootError] = useState<string | null>(null);
  const [booting, setBooting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const session = useChatStore
      .getState()
      .sessions.find((s) => s.id === sessionId);
    if (!session || session.backend !== "acp" || !session.acpAgentId) return;

    // Already bound for this agent
    if (binding && binding.agentId === session.acpAgentId && !binding.error) {
      return;
    }

    const config = usePreferencesStore
      .getState()
      .acpAgents?.find((a) => a.id === session.acpAgentId);
    if (!config) {
      setBootError("ACP agent not configured");
      return;
    }

    const live = useChatStore.getState().live;
    const cwd =
      (config.cwd && config.cwd.trim()) ||
      live.getWorkspaceRoot() ||
      live.getProjectRoot() ||
      live.getCwd();
    if (!cwd) {
      setBootError("Open a workspace folder first");
      return;
    }

    setBooting(true);
    setBootError(null);
    void useAcpStore
      .getState()
      .ensureSession({
        chatSessionId: sessionId,
        config,
        cwd,
        mcpServers: usePreferencesStore.getState().mcpServers,
      })
      .then(() => {
        if (!cancelled) setBooting(false);
      })
      .catch((e) => {
        if (!cancelled) {
          setBooting(false);
          setBootError(e instanceof Error ? e.message : String(e));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, binding?.agentId, binding?.error, binding?.acpSessionId]);

  const slots = useMemo(
    () =>
      slotConfigOptions(
        binding?.configOptions ?? null,
        binding?.modes ?? null,
      ),
    [binding?.configOptions, binding?.modes],
  );

  const applyOption = async (opt: AcpConfigOption, value: string | boolean) => {
    if (opt.id === "__legacy_mode__") {
      await setMode(sessionId, String(value));
      return;
    }
    // Claude ACP has no thought_level config — thinking is encoded in the
    // model id brackets. Rewrite model and set via the model option.
    if (opt.id === MODEL_THOUGHT_OPTION_ID && slots.model) {
      const next = modelIdAfterThoughtChange(
        slots.model,
        String(value) as ThoughtLevel,
      );
      if (!next) return;
      await setConfigOption(sessionId, slots.model.id, next);
      return;
    }
    await setConfigOption(sessionId, opt.id, value);
  };

  if (bootError && !binding) {
    return (
      <span
        className="max-w-[9rem] truncate text-[10px] text-destructive"
        title={bootError}
      >
        {bootError}
      </span>
    );
  }

  if ((booting && !binding) || !binding) {
    return (
      <div className="flex shrink-0 items-center gap-0.5">
        <PlaceholderChip title="Connecting to agent…" />
        <PlaceholderIcon title="Connecting to agent…" icon={BrainIcon} />
        <PlaceholderChip title="Connecting to agent…" />
      </div>
    );
  }

  const hasAny = !!(slots.mode || slots.thought || slots.model || slots.extra.length);
  if (!hasAny) {
    return (
      <div className="flex shrink-0 items-center gap-0.5">
        <DisabledChip
          label="Mode"
          title="This agent did not advertise session modes"
        />
        <DisabledIcon
          icon={BrainIcon}
          title="This agent did not advertise thinking levels"
        />
        <DisabledChip
          label="Model"
          title="This agent did not advertise models"
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-0.5">
      {slots.mode ? (
        <SelectChip
          option={slots.mode}
          icon={FlashIcon}
          onSelect={(v) => void applyOption(slots.mode!, v)}
        />
      ) : null}

      {slots.thought ? (
        <SelectIcon
          option={slots.thought}
          icon={BrainIcon}
          onSelect={(v) => void applyOption(slots.thought!, v)}
        />
      ) : null}

      {slots.model ? (
        <SelectChip
          option={slots.model}
          icon={SparklesIcon}
          wide
          onSelect={(v) => void applyOption(slots.model!, v)}
        />
      ) : null}

      {slots.extra.map((opt) =>
        opt.type === "boolean" ? (
          <BooleanToggle
            key={opt.id}
            option={opt}
            onToggle={(v) => void applyOption(opt, v)}
          />
        ) : (
          <SelectChip
            key={opt.id}
            option={opt}
            onSelect={(v) => void applyOption(opt, v)}
          />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared control pieces (match local ThinkingModeDropdown / ModelDropdown)
// ---------------------------------------------------------------------------

function SelectChip({
  option,
  icon,
  wide,
  onSelect,
}: {
  option: AcpConfigOption;
  icon?: typeof BrainIcon;
  wide?: boolean;
  onSelect: (value: string | boolean) => void;
}) {
  if (option.type === "boolean") {
    return <BooleanToggle option={option} onToggle={(v) => onSelect(v)} />;
  }

  const values = option.options ?? [];
  if (values.length === 0) {
    return (
      <DisabledChip
        label={optionCurrentLabel(option)}
        title={`${option.name}: no choices`}
      />
    );
  }

  const label = optionCurrentLabel(option);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "my-0 h-6 min-w-0 shrink-0 gap-1 overflow-hidden rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
            wide ? "max-w-[8.5rem]" : "max-w-[6.5rem]",
          )}
          title={`${option.name}: ${label}`}
        >
          {icon ? (
            <HugeiconsIcon
              icon={icon}
              size={12}
              strokeWidth={1.5}
              className="shrink-0 text-muted-foreground/70"
            />
          ) : null}
          <span className="min-w-0 truncate text-[11px]">{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={11}
            strokeWidth={2}
            className="shrink-0 opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 overflow-hidden rounded-xl border border-border/70 p-0 shadow-xl"
      >
        <div className="border-b border-border/60 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {option.name}
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {values.map((v) => {
            // Match Zed: highlight via value equality or alias resolution
            const active = isOptionSelected(option, v.value);
            // Prefer short name; avoid dumping raw model ids with brackets
            const title =
              v.name && v.name !== v.value
                ? v.name
                : v.name.includes("[")
                  ? v.name.slice(0, v.name.indexOf("["))
                  : v.name;
            return (
              <DropdownMenuItem
                key={v.value}
                onSelect={(e) => {
                  e.preventDefault();
                  onSelect(v.value);
                }}
                className={cn(
                  "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                  active ? "bg-accent/60 text-foreground" : "text-foreground/85",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-none">
                  {title}
                </span>
                <HugeiconsIcon
                  icon={Tick01Icon}
                  size={13}
                  strokeWidth={2}
                  className={cn(
                    "shrink-0 text-foreground transition-opacity",
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

/** Icon-only select — same footprint as ThinkingModeDropdown compact. */
function SelectIcon({
  option,
  icon,
  onSelect,
}: {
  option: AcpConfigOption;
  icon: typeof BrainIcon;
  onSelect: (value: string | boolean) => void;
}) {
  if (option.type === "boolean") {
    const on = option.currentValue === true;
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn(
          "size-6 shrink-0 rounded-md hover:bg-accent hover:text-foreground",
          on
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground/50",
        )}
        title={`${option.name}: ${on ? "on" : "off"}`}
        onClick={() => onSelect(!on)}
      >
        <HugeiconsIcon icon={icon} size={12} strokeWidth={1.5} />
      </Button>
    );
  }

  const values = option.options ?? [];
  const label = optionCurrentLabel(option);
  const activeValue =
    typeof option.currentValue === "string" ? option.currentValue : "";
  const isOff = /^(off|none|disabled|0)$/i.test(activeValue);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={values.length === 0}
          className={cn(
            "size-6 shrink-0 rounded-md hover:bg-accent hover:text-foreground",
            values.length === 0
              ? "text-muted-foreground/30"
              : isOff
                ? "text-muted-foreground/50"
                : "text-amber-600 dark:text-amber-400",
          )}
          title={`${option.name}: ${label}`}
        >
          <HugeiconsIcon
            icon={icon}
            size={12}
            strokeWidth={1.5}
            className="shrink-0 text-muted-foreground/70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 overflow-hidden rounded-xl border border-border/70 p-0 shadow-xl"
      >
        <div className="max-h-60 overflow-y-auto py-1">
          {values.map((v) => {
            const active = isOptionSelected(option, v.value);
            return (
              <DropdownMenuItem
                key={v.value}
                onSelect={(e) => {
                  e.preventDefault();
                  onSelect(v.value);
                }}
                className={cn(
                  "group mx-1 my-0.5 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                  active
                    ? "bg-accent/60 text-foreground"
                    : "text-foreground/85",
                )}
              >
                <span className="text-[12px] font-medium leading-none">
                  {v.name}
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

function BooleanToggle({
  option,
  onToggle,
}: {
  option: AcpConfigOption;
  onToggle: (value: boolean) => void;
}) {
  const on = option.currentValue === true;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-6 shrink-0 gap-1 rounded-md px-1.5 text-[11px]",
        on
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground",
      )}
      title={`${option.name}: ${on ? "on" : "off"}`}
      onClick={() => onToggle(!on)}
    >
      <span className="truncate">{option.name}</span>
      <span className="text-[10px] opacity-70">{on ? "On" : "Off"}</span>
    </Button>
  );
}

function PlaceholderChip({ title }: { title: string }) {
  return (
    <div
      className="flex h-6 min-w-[3.5rem] items-center justify-center rounded-md px-1.5"
      title={title}
    >
      <Spinner className="size-3 text-muted-foreground/50" />
    </div>
  );
}

function PlaceholderIcon({
  title,
  icon,
}: {
  title: string;
  icon: typeof BrainIcon;
}) {
  return (
    <div
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground/30"
      title={title}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.5} />
    </div>
  );
}

function DisabledChip({ label, title }: { label: string; title: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled
      className="h-6 max-w-[6.5rem] min-w-0 shrink-0 gap-1 overflow-hidden rounded-md px-1.5 text-xs text-muted-foreground/40"
      title={title}
    >
      <span className="truncate text-[11px]">{label}</span>
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 opacity-40"
      />
    </Button>
  );
}

function DisabledIcon({
  icon,
  title,
}: {
  icon: typeof BrainIcon;
  title: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled
      className="size-6 shrink-0 rounded-md text-muted-foreground/30"
      title={title}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.5} />
    </Button>
  );
}
