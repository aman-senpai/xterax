import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AGENT_ICONS } from "@/modules/ai/components/AgentSwitcher";
import {
  type Agent,
  type AgentIconId,
  BUILTIN_AGENTS,
  builtinAgentPromptKey,
  isValidHandle as isValidAgentHandle,
  slugifyHandle,
  TOOL_GROUPS,
} from "@/modules/ai/lib/agents";
import {
  clearOverride,
  getDefaultPrompt,
  getPrompt,
  setOverride,
} from "@/modules/ai/lib/prompts";
import {
  isValidHandle,
  normalizeHandle,
  type Snippet,
} from "@/modules/ai/lib/snippets";
import { THINKING_LEVELS, type ThinkingLevel } from "@/modules/ai/lib/thinking";
import { newAgentId, useAgentsStore } from "@/modules/ai/store/agentsStore";
import {
  newSnippetId,
  useSnippetsStore,
} from "@/modules/ai/store/snippetsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type AgentOverride,
  setAgentOverrides,
  setCustomInstructions,
  setPromptOverrides,
} from "@/modules/settings/store";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const ICON_OPTIONS: AgentIconId[] = [
  "coder",
  "architect",
  "reviewer",
  "security",
  "designer",
  "verification",
  "spark",
];

// Module-level selectors — stable references for Zustand v5.
const selectCustomInstructions = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.customInstructions;
const selectPromptOverrides = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.promptOverrides;
const selectAgentOverrides = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.agentOverrides;
const selectCustomAgents = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.customAgents;
const selectUpsertAgent = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.upsert;
const selectRemoveAgent = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.remove;
const selectHydrateAgents = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.hydrate;
const selectSnippets = (s: ReturnType<typeof useSnippetsStore.getState>) =>
  s.snippets;
const selectUpsertSnippet = (s: ReturnType<typeof useSnippetsStore.getState>) =>
  s.upsert;
const selectRemoveSnippet = (s: ReturnType<typeof useSnippetsStore.getState>) =>
  s.remove;
const selectHydrateSnippets = (
  s: ReturnType<typeof useSnippetsStore.getState>,
) => s.hydrate;

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function AgentsSection() {
  const customInstructions = usePreferencesStore(selectCustomInstructions);
  const promptOverrides = usePreferencesStore(selectPromptOverrides);
  const agentOverrides = usePreferencesStore(selectAgentOverrides);

  const customAgents = useAgentsStore(selectCustomAgents);
  const upsertAgent = useAgentsStore(selectUpsertAgent);
  const removeAgent = useAgentsStore(selectRemoveAgent);
  const hydrateAgents = useAgentsStore(selectHydrateAgents);

  const snippets = useSnippetsStore(selectSnippets);
  const upsertSnippet = useSnippetsStore(selectUpsertSnippet);
  const removeSnippet = useSnippetsStore(selectRemoveSnippet);
  const hydrateSnippets = useSnippetsStore(selectHydrateSnippets);

  useEffect(() => {
    void hydrateAgents();
    void hydrateSnippets();
  }, [hydrateAgents, hydrateSnippets]);

  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null);

  // Build effective built-in agents (with overrides applied) for the card display
  const effectiveBuiltins = BUILTIN_AGENTS.map((a) => ({
    ...a,
    instructions:
      agentOverrides[a.id]?.instructions ??
      getPrompt(builtinAgentPromptKey(a.id)),
    toolAllowlist:
      agentOverrides[a.id]?.toolAllowlist !== undefined
        ? agentOverrides[a.id].toolAllowlist!
        : a.toolAllowlist,
    shellAllowlist: agentOverrides[a.id]?.shellAllowlist ?? a.shellAllowlist,
    modelId:
      agentOverrides[a.id]?.modelId !== undefined
        ? agentOverrides[a.id].modelId!
        : a.modelId,
    thinkingLevel:
      agentOverrides[a.id]?.thinkingLevel !== undefined
        ? agentOverrides[a.id].thinkingLevel!
        : a.thinkingLevel,
    workflow:
      agentOverrides[a.id]?.workflow !== undefined
        ? agentOverrides[a.id].workflow!
        : a.workflow,
  }));

  const handleSaveBuiltin = useCallback(
    (agent: Agent) => {
      const key = builtinAgentPromptKey(agent.id);
      const defaultPrompt = getDefaultPrompt(key);
      const ao: AgentOverride = {};

      if (
        agent.instructions.trim() !== defaultPrompt.trim() &&
        agent.instructions.trim() !== ""
      ) {
        ao.instructions = agent.instructions;
        setOverride(key, agent.instructions);
      } else {
        ao.instructions = undefined;
        clearOverride(key);
      }

      if (agent.toolAllowlist !== null) {
        ao.toolAllowlist = agent.toolAllowlist;
      } else {
        ao.toolAllowlist = null;
      }

      ao.shellAllowlist = agent.shellAllowlist;
      ao.modelId = agent.modelId;
      ao.thinkingLevel = agent.thinkingLevel;
      ao.workflow = agent.workflow;

      const next = { ...agentOverrides };
      const hasOverride =
        ao.instructions !== undefined ||
        ao.toolAllowlist !== null ||
        (ao.shellAllowlist && ao.shellAllowlist.length > 0) ||
        ao.modelId != null ||
        ao.thinkingLevel != null ||
        (ao.workflow && ao.workflow.length > 0);
      if (hasOverride) {
        next[agent.id] = ao;
      } else {
        delete next[agent.id];
      }
      void setAgentOverrides(next);

      const nextPrompts = { ...promptOverrides };
      if (ao.instructions) {
        nextPrompts[key] = ao.instructions;
      } else {
        delete nextPrompts[key];
      }
      void setPromptOverrides(nextPrompts);
    },
    [agentOverrides, promptOverrides],
  );

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Agents"
        description="Specialist agents invoked with @handle in chat. Order of mentions is run order. Each agent can set its own model, thinking level, tools, and optional workflow."
      />

      <CustomInstructionsBlock value={customInstructions} />

      {/* Agent cards */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Agents</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingAgent({
                id: newAgentId(),
                name: "New agent",
                handle: "new-agent",
                description: "",
                instructions: "",
                icon: "spark",
                builtIn: false,
                toolAllowlist: null,
                shellAllowlist: [],
                workflow: [],
                modelId: null,
                thinkingLevel: null,
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New agent
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[...effectiveBuiltins, ...customAgents].map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              onEdit={() => {
                if (a.builtIn) {
                  const ao = agentOverrides[a.id];
                  setEditingAgent({
                    ...a,
                    instructions:
                      ao?.instructions ??
                      getPrompt(builtinAgentPromptKey(a.id)),
                    toolAllowlist:
                      ao?.toolAllowlist !== undefined
                        ? ao.toolAllowlist
                        : a.toolAllowlist,
                    shellAllowlist: ao?.shellAllowlist ?? a.shellAllowlist,
                    modelId: ao?.modelId !== undefined ? ao.modelId : a.modelId,
                    thinkingLevel:
                      ao?.thinkingLevel !== undefined
                        ? ao.thinkingLevel
                        : a.thinkingLevel,
                    workflow: ao?.workflow ?? a.workflow,
                  });
                } else {
                  setEditingAgent(a);
                }
              }}
              onDelete={a.builtIn ? null : () => removeAgent(a.id)}
            />
          ))}
        </div>
      </section>

      {/* Snippets */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label>Snippets</Label>
            <span className="text-[10.5px] text-muted-foreground">
              Reusable instructions you can drop into any prompt with{" "}
              <code className="rounded bg-muted/50 px-1 font-mono">
                #handle
              </code>
              .
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() =>
              setEditingSnippet({
                id: newSnippetId(),
                handle: "",
                name: "",
                description: "",
                content: "",
              })
            }
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            New snippet
          </Button>
        </div>

        {snippets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No snippets yet. Create one and insert it with{" "}
            <code className="font-mono">#handle</code> in the AI input.
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {snippets.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
              >
                <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                  #{s.handle}
                </code>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium">
                    {s.name}
                  </span>
                  {s.description ? (
                    <span className="truncate text-[10.5px] text-muted-foreground">
                      {s.description}
                    </span>
                  ) : null}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => setEditingSnippet(s)}
                  title="Edit"
                >
                  <HugeiconsIcon
                    icon={Edit02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={() => removeSnippet(s.id)}
                  title="Delete"
                >
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AgentEditorDialog
        key={editingAgent?.id ?? "new-agent"}
        agent={editingAgent}
        existing={customAgents}
        onClose={() => setEditingAgent(null)}
        onSave={(a) => {
          if (a.builtIn) {
            handleSaveBuiltin(a);
          } else {
            upsertAgent(a);
          }
          setEditingAgent(null);
        }}
      />
      <SnippetEditorDialog
        snippet={editingSnippet}
        existing={snippets}
        onClose={() => setEditingSnippet(null)}
        onSave={(s) => {
          upsertSnippet(s);
          setEditingSnippet(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  onEdit: () => void;
  onDelete: (() => void) | null;
}) {
  const Icon = AGENT_ICONS[agent.icon] ?? SparklesIcon;
  return (
    <div className="group relative flex flex-col gap-1.5 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 transition-colors hover:border-border">
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={Icon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
            {agent.name}
            <code className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
              @{agent.handle}
            </code>
            {agent.builtIn ? (
              <span className="rounded bg-muted/50 px-1 py-0.5 text-[9px] tracking-wide text-muted-foreground uppercase">
                Built-in
              </span>
            ) : null}
          </span>
          <span className="line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {agent.description}
          </span>
          {(agent.modelId ||
            agent.thinkingLevel ||
            (agent.workflow && agent.workflow.length > 0)) && (
            <span className="mt-0.5 text-[10px] text-muted-foreground/80">
              {[
                agent.modelId ? `model: ${agent.modelId}` : null,
                agent.thinkingLevel ? `think: ${agent.thinkingLevel}` : null,
                agent.workflow?.length
                  ? `workflow: ${agent.workflow.map((h) => `@${h}`).join(" → ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      </div>
      <div className="mt-0.5 flex items-center justify-end gap-1">
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
          {onDelete ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-muted-foreground hover:text-destructive"
              onClick={onDelete}
              title="Delete"
            >
              <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent editor dialog
// ---------------------------------------------------------------------------

function AgentEditorDialog({
  agent,
  existing,
  onClose,
  onSave,
}: {
  agent: Agent | null;
  existing: Agent[];
  onClose: () => void;
  onSave: (a: Agent) => void;
}) {
  const [draft, setDraft] = useState<Agent | null>(agent);
  useEffect(() => setDraft(agent), [agent]);
  if (!draft) return null;

  const isNew = !existing.some((a) => a.id === draft.id) && !draft.builtIn;
  const handleOk = draft.builtIn || isValidAgentHandle(draft.handle);
  const canSave = draft.name.trim().length > 0 && handleOk;

  // Normalize: treat undefined toolAllowlist as null (all allowed)
  const normalizedAllowlist: string[] | null =
    draft.toolAllowlist === undefined || draft.toolAllowlist === null
      ? null
      : draft.toolAllowlist;

  // Tool allowlist helpers
  const allAllowed = normalizedAllowlist === null;
  const toggleAllTools = () => {
    setDraft({
      ...draft,
      toolAllowlist: allAllowed ? [] : null,
    });
  };
  const toggleToolGroup = (groupId: string) => {
    if (normalizedAllowlist === null) {
      // Currently all allowed — switch to explicit list with all except this one
      setDraft({
        ...draft,
        toolAllowlist: TOOL_GROUPS.filter((g) => g.id !== groupId).map(
          (g) => g.id,
        ),
      });
    } else {
      const list = normalizedAllowlist;
      if (list.includes(groupId)) {
        setDraft({
          ...draft,
          toolAllowlist: list.filter((g) => g !== groupId),
        });
      } else {
        setDraft({ ...draft, toolAllowlist: [...list, groupId] });
      }
    }
  };

  // Shell allowlist helpers
  const shellList: string[] = draft.shellAllowlist ?? [];
  const [newShellPattern, setNewShellPattern] = useState("");
  const addShellPattern = () => {
    const p = newShellPattern.trim();
    if (!p) return;
    if (shellList.includes(p)) {
      setNewShellPattern("");
      return;
    }
    setDraft({
      ...draft,
      shellAllowlist: [...shellList, p],
    });
    setNewShellPattern("");
  };
  const removeShellPattern = (pattern: string) => {
    setDraft({
      ...draft,
      shellAllowlist: shellList.filter((p) => p !== pattern),
    });
  };

  return (
    <Dialog open={!!agent} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {draft.builtIn
              ? `Edit ${draft.name}`
              : isNew
                ? "New agent"
                : "Edit agent"}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-4">
          {/* Icon + Name + Description */}
          <div className="flex gap-2">
            <div className="flex flex-col gap-1">
              <Label>Icon</Label>
              <div className="flex flex-wrap gap-1">
                {ICON_OPTIONS.map((id) => {
                  const Icon = AGENT_ICONS[id] ?? SparklesIcon;
                  const active = draft.icon === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setDraft({ ...draft, icon: id })}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-md border transition-colors",
                        active
                          ? "border-foreground/40 bg-accent"
                          : "border-border/60 hover:bg-accent/40",
                      )}
                    >
                      <HugeiconsIcon icon={Icon} size={13} strokeWidth={1.75} />
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const next = { ...draft, name };
                  if (
                    !draft.builtIn &&
                    (!draft.handle || draft.handle === "new-agent")
                  ) {
                    next.handle = slugifyHandle(name) || draft.handle;
                  }
                  setDraft(next);
                }}
                className="h-8 text-[12px]"
                placeholder="e.g. Test Engineer"
                disabled={draft.builtIn}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>@ Handle</Label>
            <Input
              value={draft.handle}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  handle: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, ""),
                })
              }
              placeholder="architect"
              className="h-8 font-mono text-[12px]"
              disabled={draft.builtIn}
            />
            <span className="text-[10px] text-muted-foreground">
              Invoke with @{draft.handle || "handle"} in chat. Mentions run in
              the order written.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the agent picker"
              className="h-8 text-[12px]"
              disabled={draft.builtIn}
            />
          </div>

          {/* Model + thinking */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label>Model (optional)</Label>
              <Input
                value={draft.modelId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    modelId: e.target.value.trim() || null,
                  })
                }
                placeholder="Default subagent model"
                className="h-8 font-mono text-[11px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Thinking (optional)</Label>
              <select
                value={draft.thinkingLevel ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft({
                    ...draft,
                    thinkingLevel: (v || null) as ThinkingLevel | null,
                  });
                }}
                className="h-8 rounded-md border border-border/60 bg-background px-2 text-[12px]"
              >
                <option value="">Session / subagent default</option>
                {THINKING_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Workflow */}
          <div className="flex flex-col gap-1">
            <Label>Workflow (optional)</Label>
            <Input
              value={(draft.workflow ?? []).join(", ")}
              onChange={(e) => {
                const workflow = e.target.value
                  .split(/[,\s]+/)
                  .map((s) => s.replace(/^@/, "").trim())
                  .filter(Boolean);
                setDraft({ ...draft, workflow });
              }}
              placeholder="architect, claude-code, verification"
              className="h-8 font-mono text-[11px]"
            />
            <span className="text-[10px] text-muted-foreground">
              Comma-separated handles (local or ACP agents from Settings). When
              this agent is @mentioned, expand to that sequence instead of
              running alone.
            </span>
          </div>

          {/* Instructions */}
          <div className="flex flex-col gap-1">
            <Label>Instructions</Label>
            <Textarea
              value={draft.instructions}
              onChange={(e) =>
                setDraft({ ...draft, instructions: e.target.value })
              }
              placeholder="Persona and rules for this agent."
              className="min-h-32 resize-y text-[12px] leading-relaxed"
            />
            {draft.builtIn && (
              <span className="text-[10px] text-muted-foreground">
                Overrides the default {draft.name} persona prompt.
              </span>
            )}
          </div>

          {/* Tool Allowlist */}
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="flex items-center justify-between">
              <div className="flex flex-col gap-0.5">
                <span className="text-[12px] font-medium">Tool Allowlist</span>
                <span className="text-[10px] text-muted-foreground">
                  Tool groups this agent can use. Unchecked tools are hidden
                  from the model.
                </span>
              </div>
              <Button
                size="xs"
                variant={allAllowed ? "default" : "outline"}
                onClick={toggleAllTools}
                className="h-6 text-[10px]"
              >
                {allAllowed ? "Allow all" : "Restrict"}
              </Button>
            </div>
            {!allAllowed && (
              <div className="grid grid-cols-2 gap-1.5">
                {TOOL_GROUPS.map((group) => {
                  const checked =
                    normalizedAllowlist !== null &&
                    normalizedAllowlist.includes(group.id);
                  return (
                    <div
                      key={group.id}
                      role="checkbox"
                      aria-checked={checked}
                      tabIndex={0}
                      onClick={() => toggleToolGroup(group.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleToolGroup(group.id);
                        }
                      }}
                      className={cn(
                        "flex items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-colors cursor-pointer",
                        checked
                          ? "border-foreground/20 bg-accent/50"
                          : "border-border/40 hover:bg-accent/20",
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                          checked
                            ? "border-primary bg-primary"
                            : "border-muted-foreground/30 bg-input/90",
                        )}
                      >
                        {checked && (
                          <div className="size-2 rounded-full bg-background" />
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[11px] font-medium">
                          {group.label}
                        </span>
                        <span className="text-[9.5px] leading-relaxed text-muted-foreground">
                          {group.description}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Shell Command Allowlist */}
          <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">
                Shell Command Allowlist
              </span>
              <span className="text-[10px] text-muted-foreground">
                Glob patterns for shell commands this agent can run. Use{" "}
                <code className="rounded bg-muted/50 px-1">*</code> as wildcard.
                Empty = all commands allowed.
              </span>
            </div>

            {shellList.length > 0 && (
              <ul className="flex flex-col gap-1">
                {shellList.map((p) => (
                  <li
                    key={p}
                    className="flex items-center gap-2 rounded-md border border-border/40 bg-card/40 px-2.5 py-1.5"
                  >
                    <code className="flex-1 font-mono text-[11px]">{p}</code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-5 text-muted-foreground hover:text-destructive"
                      onClick={() => removeShellPattern(p)}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={10}
                        strokeWidth={1.75}
                      />
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-1.5">
              <Input
                value={newShellPattern}
                onChange={(e) => setNewShellPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addShellPattern();
                  }
                }}
                placeholder="e.g. npm *, git *"
                className="h-7 font-mono text-[11px]"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px]"
                onClick={addShellPattern}
              >
                Add
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Snippet editor dialog
// ---------------------------------------------------------------------------

function SnippetEditorDialog({
  snippet,
  existing,
  onClose,
  onSave,
}: {
  snippet: Snippet | null;
  existing: Snippet[];
  onClose: () => void;
  onSave: (s: Snippet) => void;
}) {
  const [draft, setDraft] = useState<Snippet | null>(snippet);
  useEffect(() => setDraft(snippet), [snippet]);
  if (!draft) return null;

  const handleErr = !draft.handle
    ? "Required."
    : !isValidHandle(draft.handle)
      ? "Lowercase letters, digits, and dashes only."
      : existing.some((s) => s.id !== draft.id && s.handle === draft.handle)
        ? "Already in use."
        : null;
  const canSave =
    !handleErr &&
    draft.name.trim().length > 0 &&
    draft.content.trim().length > 0;

  return (
    <Dialog open={!!snippet} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {existing.some((s) => s.id === draft.id)
              ? "Edit snippet"
              : "New snippet"}
          </DialogTitle>
        </DialogHeader>
        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex w-32 flex-col gap-1">
              <Label>Handle</Label>
              <div className="relative">
                <span className="absolute top-1/2 left-2 -translate-y-1/2 font-mono text-[11.5px] text-muted-foreground">
                  #
                </span>
                <Input
                  value={draft.handle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      handle: normalizeHandle(e.target.value),
                    })
                  }
                  placeholder="review"
                  className="h-8 pl-5 font-mono text-[11.5px]"
                />
              </div>
              {handleErr ? (
                <span className="text-[10px] text-destructive">
                  {handleErr}
                </span>
              ) : null}
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Pre-merge review checklist"
                className="h-8 text-[12px]"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="One line — shown in the # picker"
              className="h-8 text-[12px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Content</Label>
            <Textarea
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
              placeholder="Inserted into the prompt as a <snippet> block when you use #handle."
              className="min-h-40 resize-y font-mono text-[11.5px] leading-relaxed"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Custom instructions block
// ---------------------------------------------------------------------------

function CustomInstructionsBlock({ value }: { value: string }) {
  const [draft, setDraft] = useState(value);
  const hadFirstSync = useRef(false);

  useEffect(() => {
    if (!hadFirstSync.current) {
      hadFirstSync.current = true;
      setDraft(value);
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>Custom instructions</Label>
        {draft && (
          <Button size="xs" onClick={() => void setCustomInstructions(draft)}>
            Save
          </Button>
        )}
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="e.g. Always reply in concise bullet points. Prefer pnpm over npm. My machine is an M-series Mac."
        className="min-h-[100px] resize-y bg-card/60 font-sans text-[12px] leading-relaxed border border-border"
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
