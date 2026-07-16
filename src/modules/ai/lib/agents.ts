import { LazyStore } from "@tauri-apps/plugin-store";
import { getAgentPrompt, type PromptKey } from "./prompts";
import type { ThinkingLevel } from "./thinking";

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "verification"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  /** @mention handle, unique, lowercase [a-z0-9-]+ */
  handle: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
  /** Tool groups to allow. null = all tools allowed. */
  toolAllowlist: string[] | null;
  /** Glob patterns for allowed shell commands. */
  shellAllowlist: string[];
  /**
   * Optional workflow: ordered list of agent handles.
   * When @mentioned, expands to that sequence (this agent's own
   * instructions run only if workflow is empty).
   */
  workflow: string[];
  /** Per-agent model override. null = fall back to subagent/session default. */
  modelId: string | null;
  /** Per-agent thinking level. null = fall back to subagent/session default. */
  thinkingLevel: ThinkingLevel | null;
};

// ---------------------------------------------------------------------------
// Tool group constants for allowlist UI
// ---------------------------------------------------------------------------

export type ToolGroup = {
  id: string;
  label: string;
  description: string;
  tools: string[];
};

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    id: "fs",
    label: "File System",
    description: "read_file, list_directory, write_file, create_directory",
    tools: ["read_file", "list_directory", "write_file", "create_directory"],
  },
  {
    id: "edit",
    label: "Edit",
    description: "edit, multi_edit",
    tools: ["edit", "multi_edit"],
  },
  {
    id: "search",
    label: "Search",
    description: "grep, glob",
    tools: ["grep", "glob"],
  },
  {
    id: "shell",
    label: "Shell",
    description: "bash_run, bash_background, bash_logs, bash_list, bash_kill",
    tools: [
      "bash_run",
      "bash_background",
      "bash_logs",
      "bash_list",
      "bash_kill",
    ],
  },
  {
    id: "subagent",
    label: "Subagent",
    description: "run_subagent",
    tools: ["run_subagent"],
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "get_terminal_output, suggest_command, open_preview",
    tools: ["get_terminal_output", "suggest_command", "open_preview"],
  },
  {
    id: "todo",
    label: "Todo",
    description: "todo_write",
    tools: ["todo_write"],
  },
  {
    id: "agent_managed",
    label: "Agent Managed",
    description: "spawn_coding_agent, send_to_agent, read_agent_output",
    tools: ["spawn_coding_agent", "send_to_agent", "read_agent_output"],
  },
  {
    id: "mcp",
    label: "MCP",
    description: "MCP server tools (dynamic)",
    tools: ["mcp__*"],
  },
] as const;

// ---------------------------------------------------------------------------
// Handle aliases — user-friendly names map to builtin handles
// ---------------------------------------------------------------------------

/** Maps alternate mention tokens to canonical agent handles. */
export const HANDLE_ALIASES: Readonly<Record<string, string>> = {
  implement: "coder",
  design: "designer",
  "review-agent": "reviewer",
  review: "reviewer",
  verify: "verification",
};

export const MAX_PIPELINE_STEPS = 8;

// ---------------------------------------------------------------------------
// Built-in agent definitions
// ---------------------------------------------------------------------------

function builtin(
  partial: Omit<
    Agent,
    "builtIn" | "workflow" | "modelId" | "thinkingLevel" | "shellAllowlist"
  > &
    Partial<
      Pick<Agent, "workflow" | "modelId" | "thinkingLevel" | "shellAllowlist">
    >,
): Agent {
  return {
    ...partial,
    builtIn: true,
    workflow: partial.workflow ?? [],
    modelId: partial.modelId ?? null,
    thinkingLevel: partial.thinkingLevel ?? null,
    shellAllowlist: partial.shellAllowlist ?? ["*"],
  };
}

export const BUILTIN_AGENTS: readonly Agent[] = [
  builtin({
    id: "builtin:xterax",
    name: "Xterax",
    handle: "xterax",
    description:
      "Unified default agent. Plans complex work, delegates to specialists, executes efficiently.",
    icon: "spark",
    instructions: getAgentPrompt("xterax"),
    toolAllowlist: null,
  }),
  builtin({
    id: "builtin:coder",
    name: "Coder",
    handle: "coder",
    description: "General-purpose coding assistant. Writes, edits, and runs.",
    icon: "coder",
    instructions: getAgentPrompt("coder"),
    toolAllowlist: null,
  }),
  builtin({
    id: "builtin:architect",
    name: "Architect",
    handle: "architect",
    description: "Design and tradeoffs. Plans before code.",
    icon: "architect",
    instructions: getAgentPrompt("architect"),
    toolAllowlist: ["fs", "search", "todo"],
  }),
  builtin({
    id: "builtin:reviewer",
    name: "Code Reviewer",
    handle: "reviewer",
    description: "Reviews diffs for correctness, perf, security.",
    icon: "reviewer",
    instructions: getAgentPrompt("reviewer"),
    toolAllowlist: ["fs", "search"],
  }),
  builtin({
    id: "builtin:security",
    name: "Security",
    handle: "security",
    description: "Threat-models changes and flags vulns.",
    icon: "security",
    instructions: getAgentPrompt("security"),
    toolAllowlist: ["fs", "search"],
  }),
  builtin({
    id: "builtin:designer",
    name: "Designer",
    handle: "designer",
    description: "UI/UX critique and refinement.",
    icon: "designer",
    instructions: getAgentPrompt("designer"),
    toolAllowlist: ["fs", "search"],
  }),
  builtin({
    id: "builtin:verification",
    name: "Verification",
    handle: "verification",
    description: "Runs checks and confirms the work is done.",
    icon: "verification",
    instructions: getAgentPrompt("verification"),
    toolAllowlist: ["fs", "search", "shell", "todo"],
  }),
];

/** Prompt key for a built-in agent's persona. */
export function builtinAgentPromptKey(agentId: string): PromptKey {
  const id = agentId.startsWith("builtin:") ? agentId.slice(8) : agentId;
  return `agent:${id}` as PromptKey;
}

const STORE_PATH = "xterax-agents.json";
const KEY_CUSTOM = "customAgents";
const KEY_ACTIVE = "activeAgentId";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedAgents = {
  custom: Agent[];
  activeId: string;
};

const HANDLE_RE = /^[a-z][a-z0-9-]*$/;

/** Normalize a free-form name into a valid handle, or empty if impossible. */
export function slugifyHandle(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle) && handle.length >= 1 && handle.length <= 40;
}

function normalizeAgent(a: Partial<Agent> & { [k: string]: unknown }): Agent {
  const name = typeof a.name === "string" && a.name ? a.name : "Unnamed";
  const rawHandle =
    typeof a.handle === "string" && a.handle ? a.handle : slugifyHandle(name);
  const handle = isValidHandle(rawHandle)
    ? rawHandle
    : slugifyHandle(name) || "agent";
  const icon = (a.icon as AgentIconId | undefined) ?? "spark";
  return {
    id: typeof a.id === "string" && a.id ? a.id : newAgentId(),
    name,
    handle,
    description: typeof a.description === "string" ? a.description : "",
    instructions: typeof a.instructions === "string" ? a.instructions : "",
    icon,
    builtIn: a.builtIn === true,
    toolAllowlist:
      a.toolAllowlist === undefined
        ? null
        : (a.toolAllowlist as string[] | null),
    shellAllowlist: Array.isArray(a.shellAllowlist)
      ? (a.shellAllowlist as string[])
      : [],
    workflow: Array.isArray(a.workflow)
      ? (a.workflow as string[]).filter((h) => typeof h === "string")
      : [],
    modelId:
      typeof a.modelId === "string" && a.modelId.length > 0 ? a.modelId : null,
    thinkingLevel:
      a.thinkingLevel === "off" ||
      a.thinkingLevel === "low" ||
      a.thinkingLevel === "medium" ||
      a.thinkingLevel === "high" ||
      a.thinkingLevel === "max"
        ? a.thinkingLevel
        : null,
  };
}

export async function loadAgents(): Promise<LoadedAgents> {
  const entries = await store.entries();
  let custom: Agent[] | undefined;
  let activeId: string | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) {
      const raw = v as Array<Partial<Agent> & { [k: string]: unknown }>;
      custom = raw.map(normalizeAgent);
    } else if (k === KEY_ACTIVE) {
      activeId = v as string;
    }
  }
  return {
    custom: custom ?? [],
    activeId: activeId ?? BUILTIN_AGENTS[0].id,
  };
}

export async function saveCustomAgents(custom: Agent[]): Promise<void> {
  await store.set(KEY_CUSTOM, custom);
  await store.save();
}

export async function saveActiveAgentId(id: string): Promise<void> {
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

export function newAgentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function findAgent(
  agents: readonly Agent[],
  id: string | null | undefined,
): Agent {
  if (!id) return BUILTIN_AGENTS[0];
  return agents.find((a) => a.id === id) ?? BUILTIN_AGENTS[0];
}

/** Resolve a mention token (handle or alias) to a canonical handle. */
export function resolveHandleToken(token: string): string {
  const t = token.trim().toLowerCase();
  return HANDLE_ALIASES[t] ?? t;
}

/** Find an agent by handle or alias among a list. */
export function findAgentByHandle(
  agents: readonly Agent[],
  token: string,
): Agent | undefined {
  const handle = resolveHandleToken(token);
  return agents.find((a) => a.handle === handle);
}

// ---------------------------------------------------------------------------
// Pipeline targets (local agents + ACP external agents)
// ---------------------------------------------------------------------------

/** Minimal ACP config shape so agents.ts stays free of acp module deps. */
export type AcpAgentRef = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  cwd?: string | null;
};

/** One executable step after mention + workflow expansion. */
export type PipelineStep =
  | { kind: "local"; agent: Agent }
  | { kind: "acp"; handle: string; config: AcpAgentRef };

/**
 * Stable @handle for an ACP agent. Prefer slugified name; fall back to id.
 * When `reserved` collides (local agent handles), suffix with id.
 */
export function acpAgentHandle(
  config: AcpAgentRef,
  reserved?: ReadonlySet<string>,
): string {
  let base = slugifyHandle(config.name);
  if (!base || !isValidHandle(base)) {
    base = slugifyHandle(config.id) || "acp-agent";
  }
  if (!isValidHandle(base)) base = "acp-agent";
  if (!reserved || !reserved.has(base)) return base;
  const fromId = slugifyHandle(config.id);
  if (fromId && isValidHandle(fromId) && !reserved.has(fromId)) return fromId;
  let i = 2;
  while (reserved.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Build handle → ACP config map (enabled only). Local handles win collisions. */
export function buildAcpHandleMap(
  acpAgents: readonly AcpAgentRef[],
  localAgents: readonly Agent[],
): Map<string, AcpAgentRef> {
  const reserved = new Set(localAgents.map((a) => a.handle));
  for (const a of localAgents) {
    // aliases also reserved so ACP cannot steal "implement" etc.
    for (const [alias, target] of Object.entries(HANDLE_ALIASES)) {
      if (target === a.handle) reserved.add(alias);
    }
  }
  const map = new Map<string, AcpAgentRef>();
  for (const c of acpAgents) {
    if (!c.enabled) continue;
    const handle = acpAgentHandle(c, reserved);
    reserved.add(handle);
    map.set(handle, c);
  }
  return map;
}

export function findAcpByHandle(
  acpByHandle: ReadonlyMap<string, AcpAgentRef>,
  token: string,
): { handle: string; config: AcpAgentRef } | undefined {
  const handle = resolveHandleToken(token);
  // ACP does not use local aliases (implement → coder), resolve raw first
  const raw = token.trim().toLowerCase();
  const config = acpByHandle.get(raw) ?? acpByHandle.get(handle);
  if (!config) return undefined;
  // Return the map key that matched
  if (acpByHandle.has(raw)) return { handle: raw, config };
  return { handle, config };
}

/**
 * Expand an agent (and nested workflows) into a flat ordered list of steps.
 * Workflow entries may resolve to local agents or ACP agents.
 * Agents with an empty workflow are leaves. Cycles and depth caps are enforced.
 */
export function expandWorkflow(
  agents: readonly Agent[],
  start: Agent,
  options?: {
    maxSteps?: number;
    acpByHandle?: ReadonlyMap<string, AcpAgentRef>;
  },
): { steps: PipelineStep[]; error?: string } {
  const maxSteps = options?.maxSteps ?? MAX_PIPELINE_STEPS;
  const acpByHandle = options?.acpByHandle ?? new Map();
  const byHandle = new Map(agents.map((a) => [a.handle, a]));
  const out: PipelineStep[] = [];
  const stack: string[] = [];

  function walkLocal(agent: Agent): string | undefined {
    if (out.length >= maxSteps) {
      return `Pipeline exceeds ${maxSteps} steps`;
    }
    if (stack.includes(agent.handle)) {
      return `Workflow cycle at @${agent.handle}`;
    }
    const steps = agent.workflow ?? [];
    if (steps.length === 0) {
      out.push({ kind: "local", agent });
      return undefined;
    }
    stack.push(agent.handle);
    for (const token of steps) {
      const err = walkToken(token);
      if (err) {
        stack.pop();
        return err;
      }
      if (out.length > maxSteps) {
        stack.pop();
        return `Pipeline exceeds ${maxSteps} steps`;
      }
    }
    stack.pop();
    return undefined;
  }

  function walkToken(token: string): string | undefined {
    const local = findAgentByHandle(agents, token);
    if (local) return walkLocal(local);
    const acp = findAcpByHandle(acpByHandle, token);
    if (acp) {
      if (out.length >= maxSteps) {
        return `Pipeline exceeds ${maxSteps} steps`;
      }
      out.push({ kind: "acp", handle: acp.handle, config: acp.config });
      return undefined;
    }
    return `Unknown agent @${token}`;
  }

  // walkToken uses byHandle via findAgentByHandle — keep map for clarity
  void byHandle;

  const error = walkLocal(start);
  if (error) return { steps: [], error };
  return { steps: out };
}

/** @deprecated use expandWorkflow(...).steps mapped to agents for local-only callers */
export function expandWorkflowLocalOnly(
  agents: readonly Agent[],
  start: Agent,
  options?: { maxSteps?: number },
): { agents: Agent[]; error?: string } {
  const r = expandWorkflow(agents, start, options);
  if (r.error) return { agents: [], error: r.error };
  const onlyLocal = r.steps.every((s) => s.kind === "local");
  if (!onlyLocal) {
    return {
      agents: [],
      error: "Workflow includes ACP agents; use expandWorkflow steps",
    };
  }
  return {
    agents: r.steps
      .filter((s): s is { kind: "local"; agent: Agent } => s.kind === "local")
      .map((s) => s.agent),
  };
}

function isKnownMention(
  token: string,
  agents: readonly Agent[],
  acpByHandle: ReadonlyMap<string, AcpAgentRef>,
): boolean {
  return (
    findAgentByHandle(agents, token) !== undefined ||
    findAcpByHandle(acpByHandle, token) !== undefined
  );
}

/**
 * Parse [agent:handle] chips and bare @handle tokens from composer text.
 * Returns pipeline steps in mention order (workflows expanded) and body without mentions.
 */
export function parseAgentMentions(
  text: string,
  agents: readonly Agent[],
  acpAgents: readonly AcpAgentRef[] = [],
): {
  /** @deprecated prefer `steps` — local agents only (empty if any ACP step). */
  agents: Agent[];
  steps: PipelineStep[];
  body: string;
  handles: string[];
  error?: string;
} {
  // Agent chips use [agent:handle]; bare @handle also works. File chips use [@name]
  // and must not be treated as agent mentions.
  const chipRe = /\[agent:([a-z][a-z0-9-]*)\]/gi;
  const bareRe = /(?:^|[\s([{])@([a-z][a-z0-9-]*)\b/gi;
  const acpByHandle = buildAcpHandleMap(acpAgents, agents);

  type Hit = {
    token: string;
    index: number;
    len: number;
    kind: "chip" | "bare";
  };
  const hits: Hit[] = [];
  for (const m of text.matchAll(chipRe)) {
    if (m.index === undefined) continue;
    hits.push({
      token: m[1],
      index: m.index,
      len: m[0].length,
      kind: "chip",
    });
  }
  for (const m of text.matchAll(bareRe)) {
    if (m.index === undefined) continue;
    const full = m[0];
    const handle = m[1];
    const atOffset = full.lastIndexOf("@");
    const absIndex = m.index + atOffset;
    const overlapsChip = hits.some(
      (h) =>
        h.kind === "chip" && absIndex >= h.index && absIndex < h.index + h.len,
    );
    if (overlapsChip) continue;
    hits.push({
      token: handle,
      index: absIndex,
      len: handle.length + 1,
      kind: "bare",
    });
  }
  hits.sort((a, b) => a.index - b.index);

  const orderedHandles: string[] = [];
  const leafSteps: PipelineStep[] = [];

  for (const h of hits) {
    if (!isKnownMention(h.token, agents, acpByHandle)) continue;

    const local = findAgentByHandle(agents, h.token);
    if (local) {
      orderedHandles.push(local.handle);
      const expanded = expandWorkflow(agents, local, { acpByHandle });
      if (expanded.error) {
        return {
          agents: [],
          steps: [],
          body: text,
          handles: orderedHandles,
          error: expanded.error,
        };
      }
      for (const step of expanded.steps) {
        if (leafSteps.length >= MAX_PIPELINE_STEPS) {
          return {
            agents: [],
            steps: [],
            body: text,
            handles: orderedHandles,
            error: `Pipeline exceeds ${MAX_PIPELINE_STEPS} steps`,
          };
        }
        leafSteps.push(step);
      }
      continue;
    }

    const acp = findAcpByHandle(acpByHandle, h.token);
    if (acp) {
      orderedHandles.push(acp.handle);
      if (leafSteps.length >= MAX_PIPELINE_STEPS) {
        return {
          agents: [],
          steps: [],
          body: text,
          handles: orderedHandles,
          error: `Pipeline exceeds ${MAX_PIPELINE_STEPS} steps`,
        };
      }
      leafSteps.push({
        kind: "acp",
        handle: acp.handle,
        config: acp.config,
      });
    }
  }

  let body = text;
  body = body.replace(chipRe, (full, handle: string) =>
    isKnownMention(handle, agents, acpByHandle) ? "" : full,
  );
  body = body.replace(bareRe, (full, handle: string) => {
    if (!isKnownMention(handle, agents, acpByHandle)) return full;
    return full.slice(0, full.indexOf("@"));
  });
  body = body
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const allLocal = leafSteps.every((s) => s.kind === "local");
  return {
    agents: allLocal
      ? leafSteps.map((s) => (s as { kind: "local"; agent: Agent }).agent)
      : [],
    steps: leafSteps,
    body,
    handles: orderedHandles,
  };
}
