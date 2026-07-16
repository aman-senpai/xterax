import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  AbsoluteIcon,
  ArrowDown01Icon,
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
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";

const ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  spark: SparklesIcon,
};

// Module-level selectors — stable references to avoid Zustand v5
// useSyncExternalStore consistency-check re-renders on array returns.
const selectCustomAgents = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.customAgents;
const selectActiveId = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.activeId;
const selectSetActiveId = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.setActiveId;

/** Built-in specialist agents (all except the unified default). */
const SPECIALIST_IDS = new Set([
  "builtin:coder",
  "builtin:architect",
  "builtin:reviewer",
  "builtin:security",
  "builtin:designer",
]);

const DEFAULT_AGENT_ID = "builtin:xterax";

const EMPTY_ACP_AGENTS: import("@/modules/acp").AcpAgentConfig[] = [];
const selectAcpAgents = (s: ReturnType<typeof usePreferencesStore.getState>) =>
  s.acpAgents ?? EMPTY_ACP_AGENTS;
const selectSessions = (s: ReturnType<typeof useChatStore.getState>) =>
  s.sessions;
const selectActiveSessionId = (s: ReturnType<typeof useChatStore.getState>) =>
  s.activeSessionId;

export function AgentSwitcher({
  isMiniWindow,
  className,
}: {
  isMiniWindow?: boolean;
  className?: string;
}) {
  const customAgents = useAgentsStore(selectCustomAgents);
  const activeId = useAgentsStore(selectActiveId);
  const setActiveId = useAgentsStore(selectSetActiveId);
  const acpAgentsRaw = usePreferencesStore(selectAcpAgents);
  const acpAgents = acpAgentsRaw.filter((a) => a.enabled);
  const sessions = useChatStore(selectSessions);
  const activeSessionId = useChatStore(selectActiveSessionId);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const isAcp = activeSession?.backend === "acp";
  const activeAcp = isAcp
    ? acpAgents.find((a) => a.id === activeSession?.acpAgentId)
    : undefined;

  const list = useAgentsStore.getState().all();
  void customAgents; // keeps the store subscription alive

  const active = list.find((a) => a.id === activeId) ?? list[0];
  const isDefault = !isAcp && activeId === DEFAULT_AGENT_ID;

  const builtIn = list.filter((a) => a.builtIn);
  const specialists = builtIn.filter((a) => SPECIALIST_IDS.has(a.id));
  const custom = list.filter((a) => !a.builtIn);
  const ActiveIcon = isAcp
    ? RobotIcon
    : (ICONS[active?.icon ?? "spark"] ?? SparklesIcon);
  const activeName = isAcp
    ? (activeAcp?.name ?? "ACP agent")
    : (active?.name ?? "Xterax");

  function selectLocal(id: string) {
    setActiveId(id);
    if (activeSessionId) {
      useChatStore.getState().setSessionBackend(activeSessionId, "local");
    }
  }

  function selectAcp(agentId: string) {
    if (!activeSessionId) {
      useChatStore.getState().newSession({ backend: "acp", acpAgentId: agentId });
      return;
    }
    useChatStore
      .getState()
      .setSessionBackend(activeSessionId, "acp", agentId);
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
          title={`Agent: ${activeName}${isDefault ? " (Default)" : ""}${isAcp ? " (ACP)" : ""}`}
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
          {isDefault && (
            <span className="shrink-0 text-[9px] leading-none text-amber-500/80">
              ★
            </span>
          )}
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
        {/* Current agent indicator */}
        <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
          <HugeiconsIcon
            icon={ActiveIcon}
            size={11}
            strokeWidth={1.75}
            className="text-foreground"
          />
          <span className="text-[11px] font-medium">{activeName}</span>
          {isDefault && (
            <span className="ml-auto text-[9px] text-amber-500/80">
              Default
            </span>
          )}
          {isAcp && (
            <span className="ml-auto text-[9px] text-sky-500/80">ACP</span>
          )}
        </div>

        <DropdownMenuSeparator />

        {/* Specialists — for delegation or direct use */}
        <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Specialists
        </div>
        {specialists.map((a) => {
          const Icon = ICONS[a.icon] ?? SparklesIcon;
          const isActive = !isAcp && a.id === activeId;
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => selectLocal(a.id)}
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
                <span>{a.name}</span>
                <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                  {a.description}
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

        {/* Back to default */}
        {(!isDefault || isAcp) && (
          <DropdownMenuItem
            onSelect={() => selectLocal(DEFAULT_AGENT_ID)}
            className="flex items-center gap-2 text-[12px] text-amber-500/90"
          >
            <HugeiconsIcon
              icon={SparklesIcon}
              size={13}
              strokeWidth={1.75}
              className="mt-0.5"
            />
            <span>Switch to Xterax (Default)</span>
          </DropdownMenuItem>
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

        {custom.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pt-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Custom
            </div>
            {custom.map((a) => {
              const Icon = ICONS[a.icon] ?? SparklesIcon;
              return (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => selectLocal(a.id)}
                  className={cn(
                    "flex items-start gap-2 text-[12px]",
                    !isAcp && a.id === activeId && "bg-accent/40",
                  )}
                >
                  <HugeiconsIcon
                    icon={Icon}
                    size={13}
                    strokeWidth={1.75}
                    className="mt-0.5 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{a.name}</span>
                    {a.description ? (
                      <span className="line-clamp-1 text-[10.5px] text-muted-foreground">
                        {a.description}
                      </span>
                    ) : null}
                  </span>
                  {a.id === activeId ? (
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
          Manage agents…
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
          <code className="rounded bg-muted/40 px-1 font-mono">@</code> in the
          input to switch agents inline.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ICONS as AGENT_ICONS };
