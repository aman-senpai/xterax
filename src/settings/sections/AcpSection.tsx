import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  ACP_PRESETS,
  blankAcpAgent,
  presetToConfig,
  type AcpAgentConfig,
} from "@/modules/acp";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setAcpAgents } from "@/modules/settings/store";
import { SectionHeader } from "@/settings/components/SectionHeader";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  RobotIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

const EMPTY_ACP_AGENTS: AcpAgentConfig[] = [];
const selectAcpAgents = (s: ReturnType<typeof usePreferencesStore.getState>) =>
  s.acpAgents ?? EMPTY_ACP_AGENTS;

export function AcpSection() {
  const agents = usePreferencesStore(selectAcpAgents);
  const [editing, setEditing] = useState<AcpAgentConfig | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="ACP Agents"
        description="Agent Client Protocol agents run as local subprocesses and appear
        as backends in the AI panel. Configure command, args, and env for each agent."
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Configured agents</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => setEditing(blankAcpAgent())}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add agent
          </Button>
        </div>

        {agents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No ACP agents configured. Add a preset or custom command to chat
            with external coding agents in the AI panel.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onToggle={(enabled) => {
                  const next = agents.map((a) =>
                    a.id === agent.id ? { ...a, enabled } : a,
                  );
                  void setAcpAgents(next);
                }}
                onEdit={() => setEditing(agent)}
                onDelete={() => {
                  void setAcpAgents(agents.filter((a) => a.id !== agent.id));
                }}
              />
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Label>Presets</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ACP_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-card/70"
              onClick={() => setEditing(presetToConfig(p))}
            >
              <div className="text-[12.5px] font-medium">{p.name}</div>
              <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                {p.description}
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">
                {p.command} {p.args.join(" ")}
              </div>
            </button>
          ))}
        </div>
      </section>

      <AgentEditorDialog
        agent={editing}
        existing={agents}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          const exists = agents.some((a) => a.id === draft.id);
          const next = exists
            ? agents.map((a) => (a.id === draft.id ? draft : a))
            : [...agents, draft];
          void setAcpAgents(next);
          setEditing(null);
        }}
      />
    </div>
  );
}

function AgentCard({
  agent,
  onToggle,
  onEdit,
  onDelete,
}: {
  agent: AcpAgentConfig;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        agent.enabled
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={RobotIcon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-medium">
            {agent.name || "Unnamed agent"}
          </span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {agent.command || "No command set"}
            {agent.args.length > 0 ? ` ${agent.args.join(" ")}` : ""}
          </span>
        </div>
      </div>

      <div className="mt-0.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          <Switch
            checked={agent.enabled}
            onCheckedChange={onToggle}
            size="sm"
          />
          <span className="text-[10.5px] text-muted-foreground">
            {agent.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={onEdit}
            title="Edit"
          >
            <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.75} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    </div>
  );
}

function AgentEditorDialog({
  agent,
  existing,
  onClose,
  onSave,
}: {
  agent: AcpAgentConfig | null;
  existing: AcpAgentConfig[];
  onClose: () => void;
  onSave: (draft: AcpAgentConfig) => void;
}) {
  const [draft, setDraft] = useState<AcpAgentConfig | null>(agent);
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    if (!agent) return;
    setDraft(agent);
    setEnvText(
      Object.entries(agent.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  }, [agent]);

  if (!draft) return null;

  const isNew = !existing.some((a) => a.id === draft.id);
  const canSave =
    draft.name.trim().length > 0 && draft.command.trim().length > 0;

  function commit() {
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) env[key] = val;
    }
    onSave({ ...draft, env } as AcpAgentConfig);
  }

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "Add ACP agent" : "Edit ACP agent"}
          </DialogTitle>
        </DialogHeader>

        <div className="-mx-2 flex max-h-[calc(100vh-14rem)] flex-col gap-3 overflow-y-auto px-2">
          <div className="flex flex-col gap-1">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Claude Code"
              className="h-8 text-[12px]"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label>Command</Label>
              <Input
                value={draft.command}
                onChange={(e) =>
                  setDraft({ ...draft, command: e.target.value })
                }
                placeholder="e.g. npx"
                className="h-8 font-mono text-[11.5px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Arguments</Label>
              <Input
                value={draft.args.join(" ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    args: e.target.value
                      .split(" ")
                      .map((a) => a.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="e.g. -y @zed-industries/claude-agent-acp"
                className="h-8 font-mono text-[11.5px]"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Working directory (optional)</Label>
            <Input
              value={draft.cwd ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  cwd: e.target.value.trim() || null,
                })
              }
              placeholder="Defaults to workspace root at session start"
              className="h-8 font-mono text-[11.5px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label>Environment variables</Label>
            <Textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={"KEY=value\nANOTHER_KEY=another_value"}
              className="min-h-28 resize-y font-mono text-[11px] leading-relaxed"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">Enable agent</span>
              <span className="text-[10.5px] text-muted-foreground">
                Show in the AI panel agent switcher
              </span>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={commit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
