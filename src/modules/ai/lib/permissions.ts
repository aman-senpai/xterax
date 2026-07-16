import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  DEFAULT_PERMISSIONS,
  type ShellAllowlistEntry,
  type ToolApprovalPolicy,
  type ToolPermissions,
} from "@/modules/settings/store";
import { useAgentsStore } from "../store/agentsStore";
import type { PermissionMode } from "../store/chatStore";
import { getActiveMode } from "../store/modesStore";
import { type Agent, BUILTIN_AGENTS, TOOL_GROUPS } from "./agents";

export type ResolvedPolicy = "auto-approve" | "deny" | "ask";

/** Mutating tools that participate in per-tool settings + session modes. */
export const MUTATION_TOOL_NAMES = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "create_directory",
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
  "run_subagent",
  "bash_kill",
]);

const WRITE_PATH_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "create_directory",
]);

/**
 * Resolve the effective approval policy for a tool call.
 *
 * Priority:
 *  1. Session-level permissionMode override ("auto-approve" / "read-only")
 *  2. Active agent toolAllowlist (missing tool → deny)
 *  3. Persistent per-tool permissions from Settings → Permissions
 *  4. Writable-directory auto-approve for write tools
 *  5. Shell allowlist (global + agent) for bash_run / bash_background
 *  6. MCP tools default to "ask"
 *  7. Fallback: "ask" for mutations, "auto-approve" for pure reads
 */
export function resolveToolPolicy(
  toolName: string,
  permissionMode: PermissionMode,
  toolInput?: unknown,
  agent?: Agent | null,
): ResolvedPolicy {
  if (permissionMode === "auto-approve") return "auto-approve";
  if (permissionMode === "read-only") {
    if (isMutationTool(toolName)) return "deny";
    // MCP tools can mutate external systems — deny in read-only.
    if (isMcpTool(toolName)) return "deny";
    return "auto-approve";
  }

  const active = agent ?? getActiveAgent();
  if (active && !isToolAllowedByAgent(toolName, active.toolAllowlist)) {
    return "deny";
  }

  const prefs = usePreferencesStore.getState();
  const perms: ToolPermissions =
    prefs.permissions?.toolPermissions ?? DEFAULT_PERMISSIONS.toolPermissions;

  const key = toolName as keyof ToolPermissions;
  const policy: ToolApprovalPolicy | undefined = perms[key];

  if (policy === "auto-approve") return "auto-approve";
  if (policy === "deny") return "deny";

  // Writable directories: auto-approve file mutations under listed roots.
  if (WRITE_PATH_TOOLS.has(toolName) && toolInput) {
    const path = extractPathFromInput(toolInput);
    if (path && isPathInWritableDirectories(path)) {
      return "auto-approve";
    }
  }

  // Shell allowlist (global AND agent) — only when policy is "ask".
  if (
    (toolName === "bash_run" || toolName === "bash_background") &&
    toolInput &&
    typeof toolInput === "object" &&
    "command" in toolInput
  ) {
    const cmd = String((toolInput as Record<string, unknown>).command);
    if (isShellAllowed(cmd, active)) return "auto-approve";
  }

  // MCP: always ask in default mode (never silent auto-exec).
  if (isMcpTool(toolName)) return "ask";

  // Known mutation tools without a more specific grant: ask.
  if (isMutationTool(toolName) || MUTATION_TOOL_NAMES.has(toolName)) {
    return "ask";
  }
  return "auto-approve";
}

export function isMutationTool(toolName: string): boolean {
  if (MUTATION_TOOL_NAMES.has(toolName)) return true;
  if (isMcpTool(toolName)) return true;
  return false;
}

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

// ---- default agent (bare messages; specialists are @-invoked) --------------

/** Default local agent for turns without an @-pipeline. Always Xterax. */
export function getActiveAgent(): Agent | null {
  try {
    const list = useAgentsStore.getState().all();
    return (
      list.find((a) => a.id === "builtin:xterax") ?? BUILTIN_AGENTS[0] ?? null
    );
  } catch {
    return BUILTIN_AGENTS[0] ?? null;
  }
}

/** Effective permission mode: session picker, unless active mode overrides. */
export function getEffectivePermissionMode(
  sessionMode: PermissionMode,
): PermissionMode {
  try {
    const mode = getActiveMode();
    if (mode.permissionMode) return mode.permissionMode;
  } catch {
    // modes store not ready
  }
  return sessionMode;
}

/**
 * Expand tool-group ids and wildcards into a set of allowed tool name
 * patterns. `null` means all tools. Entries may be exact tool names,
 * group ids (fs, shell, …), or globs like `mcp__*`.
 */
export function expandToolAllowlist(
  allowlist: string[] | null | undefined,
): Set<string> | null {
  if (allowlist == null) return null;
  const out = new Set<string>();
  for (const entry of allowlist) {
    const group = TOOL_GROUPS.find((g) => g.id === entry);
    if (group) {
      for (const t of group.tools) out.add(t);
      continue;
    }
    out.add(entry);
  }
  return out;
}

export function isToolAllowedByAgent(
  toolName: string,
  allowlist: string[] | null | undefined,
): boolean {
  const expanded = expandToolAllowlist(allowlist);
  if (expanded == null) return true;
  if (expanded.has(toolName)) return true;
  // Glob entries (e.g. mcp__*)
  for (const entry of expanded) {
    if (entry.includes("*") && matchSimpleGlob(toolName, entry)) return true;
  }
  return false;
}

/** Drop tools not allowed by the agent allowlist. */
export function filterToolsByAllowlist<T extends Record<string, unknown>>(
  tools: T,
  allowlist: string[] | null | undefined,
): T {
  const expanded = expandToolAllowlist(allowlist);
  if (expanded == null) return tools;
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (isToolAllowedByAgent(name, allowlist)) out[name] = tool;
  }
  return out as T;
}

// ---- writable directories ---------------------------------------------------

export function isPathInWritableDirectories(path: string): boolean {
  const prefs = usePreferencesStore.getState();
  const dirs = prefs.permissions?.writableDirectories ?? [];
  if (dirs.length === 0) return false;
  const cmp = normalizePathForCompare(path);
  for (const dir of dirs) {
    const d = dir?.trim();
    if (!d) continue;
    const root = normalizePathForCompare(d);
    if (!root) continue;
    if (cmp === root || cmp.startsWith(root + "/")) return true;
  }
  return false;
}

function extractPathFromInput(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const rec = toolInput as Record<string, unknown>;
  if (typeof rec.path === "string") return rec.path;
  return null;
}

function normalizePathForCompare(p: string): string {
  let s = p.replace(/\\/g, "/");
  s = s.replace(/^[a-zA-Z]:/, "");
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s.toLowerCase();
}

// ---- shell allowlist -------------------------------------------------------

/**
 * Shell chaining / expansion characters. A glob allowlist entry must not
 * match a command that contains these — only an exact full-command match may.
 */
const SHELL_METACHAR_RE = /[;&|`$(){}<>\n\r]|&&|\|\||<<|>>/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHAR_RE.test(command);
}

/**
 * Whether `command` may be auto-approved via allowlists.
 * Requires an enabled global pattern match, then the agent shell allowlist
 * (when restricted) as an additional AND gate.
 */
export function isShellAllowed(command: string, agent?: Agent | null): boolean {
  const prefs = usePreferencesStore.getState();
  const globalList: ShellAllowlistEntry[] =
    prefs.permissions?.shellAllowlist ?? [];
  if (!matchesShellAllowlist(command, globalList, /* requireEnabled */ true)) {
    return false;
  }
  return agentShellAllows(command, agent ?? getActiveAgent());
}

function agentShellAllows(command: string, agent: Agent | null): boolean {
  if (!agent) return true;
  const list = agent.shellAllowlist ?? [];
  // Empty or explicit "*" → no agent-level restriction.
  if (list.length === 0 || list.some((p) => p.trim() === "*")) return true;
  return matchesShellPatternList(command, list);
}

/**
 * Global allowlist entries have {pattern, enabled}. Agent lists are bare
 * pattern strings.
 */
export function matchesShellAllowlist(
  command: string,
  allowlist: ShellAllowlistEntry[],
  requireEnabled: boolean,
): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  for (const entry of allowlist) {
    if (requireEnabled && !entry.enabled) continue;
    if (!entry.pattern?.trim()) continue;
    if (matchShellAllowlistPattern(trimmed, entry.pattern.trim())) return true;
  }
  return false;
}

function matchesShellPatternList(command: string, patterns: string[]): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  for (const p of patterns) {
    if (!p?.trim()) continue;
    if (matchShellAllowlistPattern(trimmed, p.trim())) return true;
  }
  return false;
}

/**
 * Safe shell allowlist match:
 *  - Exact full-command match always succeeds.
 *  - Glob patterns (`*`) only match when the command has no shell
 *    metacharacters (no chaining / expansion).
 *  - `*` matches within a single path segment of the pattern and cannot
 *    span newlines (already blocked by metachar check).
 */
export function matchShellAllowlistPattern(
  command: string,
  pattern: string,
): boolean {
  if (command === pattern) return true;
  if (pattern === "*") {
    // Bare star never auto-approves via the global allowlist. Agent unrestricted
    // mode short-circuits in agentShellAllows before calling this matcher.
    return false;
  }
  if (!pattern.includes("*")) return false;
  if (hasShellMetacharacters(command)) return false;
  return matchSimpleGlob(command, pattern);
}

function matchSimpleGlob(str: string, pattern: string): boolean {
  // Escape regex specials except *; then * → .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*");
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

/**
 * Filter a built tool map by default agent allowlist ∩ active mode allowlist.
 * Used by the main agent runner (not @-pipeline steps, which pass their agent).
 */
export function applyAgentToolFilter<T extends Record<string, unknown>>(
  tools: T,
  agent?: Agent | null,
): T {
  const active = agent ?? getActiveAgent();
  let next = tools;
  if (active) {
    next = filterToolsByAllowlist(next, active.toolAllowlist);
  }
  try {
    const mode = getActiveMode();
    if (mode.toolAllowlist) {
      next = filterToolsByAllowlist(next, mode.toolAllowlist);
    }
  } catch {
    // modes store not ready
  }
  return next;
}
