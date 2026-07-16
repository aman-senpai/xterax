import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AbsoluteIcon,
  ArrowDown01Icon,
  CheckListIcon,
  CodeIcon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  RobotIcon,
  Settings01Icon,
  ShieldUserIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentIconId } from "../lib/agents";
import { MODE_DEFAULT_ID, MODE_PLAN_ID, MODE_REVIEW_ID } from "../lib/modes";
import { useChatStore } from "../store/chatStore";
import { useModesStore } from "../store/modesStore";

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  verification: Tick02Icon,
  spark: SparklesIcon,
};

const MODE_ICONS: Record<string, typeof CodeIcon> = {
  [MODE_DEFAULT_ID]: SparklesIcon,
  [MODE_PLAN_ID]: CheckListIcon,
  [MODE_REVIEW_ID]: PencilEdit02Icon,
};

const selectCustomModes = (s: ReturnType<typeof useModesStore.getState>) =>
  s.customModes;
const selectActiveModeId = (s: ReturnType<typeof useModesStore.getState>) =>
  s.activeId;
const selectSetActiveModeId = (s: ReturnType<typeof useModesStore.getState>) =>
  s.setActiveId;

const EMPTY_ACP_AGENTS: import("@/modules/acp").AcpAgentConfig[] = [];
const selectAcpAgents = (s: ReturnType<typeof usePreferencesStore.getState>) =>
  s.acpAgents ?? EMPTY_ACP_AGENTS;
const selectSessions = (s: ReturnType<typeof useChatStore.getState>) =>
  s.sessions;
const selectActiveSessionId = (s: ReturnType<typeof useChatStore.getState>) =>
  s.activeSessionId;

/**
 * Session mode switcher (Default / Plan / Review / custom) plus ACP backends.
 * Specialist agents are invoked via @mentions in the composer, not here.
 */
export function AgentSwitcher({
  isMiniWindow,
  className,
}: {
  isMiniWindow?: boolean;
  className?: string;
}) {
  const customModes = useModesStore(selectCustomModes);
  const activeModeId = useModesStore(selectActiveModeId);
  const setActiveModeId = useModesStore(selectSetActiveModeId);
  const acpAgentsRaw = usePreferencesStore(selectAcpAgents);
  const acpAgents = acpAgentsRaw.filter((a) => a.enabled);
  const sessions = useChatStore(selectSessions);
  const activeSessionId = useChatStore(selectActiveSessionId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isAcp = activeSession?.backend === "acp";
  const activeAcp = isAcp
    ? acpAgents.find((a) => a.id === activeSession?.acpAgentId)
    : undefined;

  const list = useModesStore.getState().all();
  void customModes;

  const activeMode = list.find((m) => m.id === activeModeId) ?? list[0];
  const isDefaultMode = !isAcp && activeModeId === MODE_DEFAULT_ID;

  const builtInModes = list.filter((m) => m.builtIn);
  const custom = list.filter((m) => !m.builtIn);
  const ActiveIcon = isAcp
    ? RobotIcon
    : (MODE_ICONS[activeMode?.id ?? MODE_DEFAULT_ID] ?? SparklesIcon);
  const activeName = isAcp
    ? (activeAcp?.name ?? "ACP agent")
    : (activeMode?.name ?? "Default");

  function selectLocalMode(id: string) {
    setActiveModeId(id);
    if (activeSessionId) {
      useChatStore.getState().setSessionBackend(activeSessionId, "local");
    }
  }

  function selectAcp(agentId: string) {
    if (!activeSessionId) {
      useChatStore
        .getState()
        .newSession({ backend: "acp", acpAgentId: agentId });
      return;
    }
    useChatStore.getState().setSessionBackend(activeSessionId, "acp", agentId);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          className={cn(
            !isMiniWindow
              ? "flex h-6 max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-md border border-border/60 bg-card px-1.5 text-[10.5px] text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
              : "mr-1 text-xs",
            className,
          )}
          title={`Mode: ${activeName}${isAcp ? " (ACP)" : ""}`}
        >
          <HugeiconsIcon
            icon={ActiveIcon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {activeName}
          </span>
          {isAcp && (
            <span className="shrink-0 text-[9px] leading-none text-sky-500/80">
              ACP
            </span>
          )}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="shrink-0 opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
          <HugeiconsIcon
            icon={ActiveIcon}
            size={11}
            strokeWidth={1.75}
            className="text-foreground"
          />
          <span className="text-[11px] font-medium">{activeName}</span>
          {!isAcp && (
            <span className="ml-auto text-[9px] text-muted-foreground">
              Mode
            </span>
          )}
          {isAcp && (
            <span className="ml-auto text-[9px] text-sky-500/80">ACP</span>
          )}
        </div>

        <DropdownMenuSeparator />

        <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Modes
        </div>
        {builtInModes.map((m) => {
          const Icon = MODE_ICONS[m.id] ?? SparklesIcon;
          const isActive = !isAcp && m.id === activeModeId;
          return (
            <DropdownMenuItem
              key={m.id}
              onSelect={() => selectLocalMode(m.id)}
              className={cn(
                "flex items-start gap-2 pr-2 text-[12px]",
                isActive && "bg-accent/40",
              )}
            >
              <HugeiconsIcon
                icon={Icon}
                size={13}
                strokeWidth={1.75}
                className={cn(
                  "mt-0.5",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{m.name}</span>
                <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                  {m.description}
                </span>
              </span>
              {isActive ? (
                <HugeiconsIcon
                  icon={Tick02Icon}
                  size={12}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-foreground"
                />
              ) : null}
            </DropdownMenuItem>
          );
        })}

        {custom.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Custom modes
            </div>
            {custom.map((m) => {
              const isActive = !isAcp && m.id === activeModeId;
              return (
                <DropdownMenuItem
                  key={m.id}
                  onSelect={() => selectLocalMode(m.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    isActive && "bg-accent/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={SparklesIcon}
                    size={13}
                    strokeWidth={1.75}
                    className="mt-0.5 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{m.name}</span>
                    {m.description ? (
                      <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                        {m.description}
                      </span>
                    ) : null}
                  </span>
                  {isActive ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={12}
                      strokeWidth={2}
                      className="mt-0.5 shrink-0 text-foreground"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}

        {(!isDefaultMode || isAcp) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => selectLocalMode(MODE_DEFAULT_ID)}
              className="flex items-center gap-2 text-[12px] text-amber-500/90"
            >
              <HugeiconsIcon
                icon={SparklesIcon}
                size={13}
                strokeWidth={1.75}
                className="mt-0.5"
              />
              <span>Switch to Default mode</span>
            </DropdownMenuItem>
          </>
        )}

        {acpAgents.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              External (ACP)
            </div>
            {acpAgents.map((a) => {
              const isActive = isAcp && a.id === activeSession?.acpAgentId;
              return (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => selectAcp(a.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    isActive && "bg-accent/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={RobotIcon}
                    size={13}
                    strokeWidth={1.75}
                    className="mt-0.5 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{a.name}</span>
                    <span className="line-clamp-1 font-mono text-[10.5px] text-muted-foreground">
                      {a.command}
                      {a.args.length ? ` ${a.args.join(" ")}` : ""}
                    </span>
                  </span>
                  {isActive ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={12}
                      strokeWidth={2}
                      className="mt-0.5 shrink-0 text-foreground"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("agents")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
          Manage agents and modes…
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void openSettingsWindow("acp")}
          className="gap-2 text-[12px] text-muted-foreground"
        >
          <HugeiconsIcon icon={RobotIcon} size={12} strokeWidth={1.75} />
          Manage ACP agents…
        </DropdownMenuItem>
        <div className="px-2 pb-1.5 pt-0.5 text-[10px] text-muted-foreground/60">
          Tip: type{" "}
          <code className="rounded bg-muted/40 px-1 font-mono">@</code> to
          invoke agents in order.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ICONS as AGENT_ICONS };
