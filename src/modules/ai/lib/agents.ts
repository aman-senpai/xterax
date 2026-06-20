import { LazyStore } from "@tauri-apps/plugin-store";
import { getAgentPrompt, type PromptKey } from "./prompts";

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
  /** Tool groups to allow. null = all tools allowed. */
  toolAllowlist: string[] | null;
  /** Glob patterns for allowed shell commands. */
  shellAllowlist: string[];
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
    tools: ["bash_run", "bash_background", "bash_logs", "bash_list", "bash_kill"],
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
    description:
      "get_terminal_output, suggest_command, open_preview",
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
    tools: [
      "spawn_coding_agent",
      "send_to_agent",
      "read_agent_output",
    ],
  },
  {
    id: "mcp",
    label: "MCP",
    description: "MCP server tools (dynamic)",
    tools: ["mcp__*"],
  },
] as const;

// ---------------------------------------------------------------------------
// Built-in agent definitions
// ---------------------------------------------------------------------------

export const BUILTIN_AGENTS: readonly Agent[] = [
  {
    id: "builtin:xterax",
    name: "Xterax",
    description:
      "Unified default agent. Plans complex work, delegates to specialists, executes efficiently.",
    icon: "spark" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("xterax"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
  {
    id: "builtin:coder",
    name: "Coder",
    description: "General-purpose coding assistant. Writes, edits, and runs.",
    icon: "coder" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("coder"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
  {
    id: "builtin:architect",
    name: "Architect",
    description: "Design and tradeoffs. Plans before code.",
    icon: "architect" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("architect"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
  {
    id: "builtin:reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, perf, security.",
    icon: "reviewer" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("reviewer"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
  {
    id: "builtin:security",
    name: "Security",
    description: "Threat-models changes and flags vulns.",
    icon: "security" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("security"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
  {
    id: "builtin:designer",
    name: "Designer",
    description: "UI/UX critique and refinement.",
    icon: "designer" as AgentIconId,
    builtIn: true,
    instructions: getAgentPrompt("designer"),
    toolAllowlist: null,
    shellAllowlist: ["*"],
  },
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

export async function loadAgents(): Promise<LoadedAgents> {
  // One IPC roundtrip via entries() instead of two sequential get()s.
  const entries = await store.entries();
  let custom: Agent[] | undefined;
  let activeId: string | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) {
      const raw = v as Array<Partial<Agent> & { [k: string]: unknown }>;
      // Normalize legacy agents that lack the toolAllowlist / shellAllowlist fields
      custom = raw.map(
        (a): Agent => ({
          id: a.id ?? newAgentId(),
          name: a.name ?? "Unnamed",
          description: a.description ?? "",
          instructions: a.instructions ?? "",
          icon: a.icon ?? "spark",
          builtIn: a.builtIn ?? false,
          toolAllowlist:
            a.toolAllowlist === undefined ? null : a.toolAllowlist,
          shellAllowlist: a.shellAllowlist ?? [],
        }),
      );
    } else if (k === KEY_ACTIVE) {
      activeId = v as string;
    }
  }
  return { custom: custom ?? [], activeId: activeId ?? BUILTIN_AGENTS[0].id };
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
