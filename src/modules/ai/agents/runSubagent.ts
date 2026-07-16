import { streamText, stepCountIs } from "ai";
import { resolveModel, selectSystemPrompt } from "../config";
import { getAgentPrompt, getSubagentSystemPrompt } from "../lib/prompts";
import { buildConfiguredLanguageModel } from "../lib/agent";
import {
  buildThinkingProviderOptions,
  type ThinkingLevel,
} from "../lib/thinking";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { buildEditTools } from "../tools/edit";
import { buildShellTools } from "../tools/shell";
import { useChatStore, type PermissionMode } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  filterToolsByAllowlist,
  resolveToolPolicy,
} from "../lib/permissions";
import {
  pushToolStep,
  pushToolResult,
  pushTextDelta,
  pushReasoningDelta,
  pushApprovalRequired,
  finishSubagent,
} from "./subagentProgress";

/** Hard cap on parallel subagent tasks per run_subagent call. */
export const MAX_SUBAGENT_TASKS = 6;
const SUBAGENT_MAX_STEPS = 12;
const WAIT_TIMEOUT_MS = 120_000;

/** Tools each specialist role may use (group ids + tool names). */
const ROLE_TOOL_ALLOWLIST: Record<string, string[] | null> = {
  coder: null, // full
  architect: ["fs", "search", "todo"],
  reviewer: ["fs", "search"],
  security: ["fs", "search"],
  designer: ["fs", "search"],
};

const MUTATION_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "create_directory",
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
  "bash_kill",
]);

type Args = {
  jobId: string;
  prompt: string;
  description?: string;
  agentType?: string | null;
  keys: ProviderKeys;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  toolContext: ToolContext;
  abortSignal?: AbortSignal;
};

export type RunResult = {
  description?: string;
  summary: string;
  stepCount: number;
  durationMs: number;
};

// ---- Background job store ----

type JobState = "running" | "done" | "error" | "aborted";

type JobEntry = {
  description?: string;
  status: JobState;
  result?: RunResult;
  error?: string;
  startedAt: number;
  controller: AbortController;
  resolve: () => void;
};

const jobs = new Map<string, JobEntry>();

function nextJobId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function spawnSubagent(args: Omit<Args, "jobId" | "abortSignal">): string {
  const jobId = nextJobId();
  const controller = new AbortController();
  let resolve: () => void = () => {};
  void new Promise<void>((r) => {
    resolve = r;
  });

  const entry: JobEntry = {
    description: args.description,
    status: "running",
    startedAt: Date.now(),
    controller,
    resolve,
  };
  jobs.set(jobId, entry);

  // Isolated tool context: own read cache + shell scope so parallel subagents
  // cannot stomp each other's cwd or read-before-edit cache.
  const isolatedCtx: ToolContext = {
    ...args.toolContext,
    readCache: new Map(),
    getShellScopeId: () => jobId,
  };

  void (async () => {
    try {
      if (controller.signal.aborted) {
        entry.status = "aborted";
        entry.error = "aborted before start";
        finishSubagent(jobId, "aborted");
        return;
      }
      const r = await runSubagent({
        ...args,
        jobId,
        toolContext: isolatedCtx,
        abortSignal: controller.signal,
      });
      if (controller.signal.aborted) {
        entry.status = "aborted";
        entry.error = "aborted";
        finishSubagent(jobId, "aborted");
        return;
      }
      entry.status = "done";
      entry.result = { ...r, description: args.description };
    } catch (e) {
      const msg = String(e);
      const aborted =
        controller.signal.aborted ||
        /abort/i.test(msg) ||
        (e instanceof Error && e.name === "AbortError");
      entry.status = aborted ? "aborted" : "error";
      entry.error = aborted ? "aborted" : msg;
      finishSubagent(jobId, entry.error);
    } finally {
      jobs.get(jobId)?.resolve();
    }
  })();

  return jobId;
}

/** Abort a single subagent (or all if jobId omitted). */
export function abortSubagent(jobId?: string): void {
  if (jobId) {
    jobs.get(jobId)?.controller.abort();
    return;
  }
  for (const entry of jobs.values()) {
    entry.controller.abort();
  }
}

export async function waitForSubagents(
  jobIds: string[],
): Promise<
  (RunResult & { jobId: string; status: JobState; error?: string })[]
> {
  const promises = jobIds.map((id) => {
    const entry = jobs.get(id);
    if (!entry) return Promise.resolve(null);
    if (entry.status !== "running") return Promise.resolve(null);
    return new Promise<void>((r) => {
      const orig = entry.resolve;
      entry.resolve = () => {
        orig();
        r();
      };
    });
  });

  const timeout = new Promise<"timeout">((r) =>
    setTimeout(() => r("timeout"), WAIT_TIMEOUT_MS),
  );
  const raced = await Promise.race([
    Promise.all(promises).then(() => "done" as const),
    timeout,
  ]);

  // On timeout: abort still-running jobs so they stop mutating the workspace.
  if (raced === "timeout") {
    for (const id of jobIds) {
      const entry = jobs.get(id);
      if (entry?.status === "running") {
        entry.controller.abort();
      }
    }
    // Brief grace period for abort handlers to settle.
    await Promise.race([
      Promise.all(promises),
      new Promise<void>((r) => setTimeout(r, 1500)),
    ]);
  }

  const results: (RunResult & {
    jobId: string;
    status: JobState;
    error?: string;
  })[] = [];
  for (const id of jobIds) {
    const entry = jobs.get(id);
    if (!entry) {
      results.push({
        jobId: id,
        status: "error",
        error: `unknown job: ${id}`,
        summary: "",
        stepCount: 0,
        durationMs: 0,
      });
      continue;
    }
    if (entry.status === "running") {
      entry.controller.abort();
      results.push({
        jobId: id,
        status: "error",
        error: "timed out",
        description: entry.description,
        summary: "",
        stepCount: 0,
        durationMs: Date.now() - entry.startedAt,
      });
      finishSubagent(id, "timed out");
    } else {
      results.push({
        jobId: id,
        status: entry.status,
        error: entry.error,
        ...(entry.result ?? { summary: "", stepCount: 0, durationMs: 0 }),
      });
    }
    jobs.delete(id);
  }
  return results;
}

// ---- Internal runner — mirrors main agent pipeline ----

function roleAllowlist(agentType?: string | null): string[] | null {
  if (!agentType) return null;
  return ROLE_TOOL_ALLOWLIST[agentType] ?? null;
}

/** All tools except run_subagent (prevent recursion), with needsApproval
 *  stripped and execute wrapped with permission-mode-aware approval. */
function buildSubagentToolSet(
  ctx: ToolContext,
  jobId: string,
  permissionMode: PermissionMode,
  agentType?: string | null,
): Record<string, unknown> {
  const raw = {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildEditTools(ctx),
    ...buildShellTools(ctx),
  };

  // Specialist roles get a reduced tool surface.
  const roleFiltered = filterToolsByAllowlist(raw, roleAllowlist(agentType));

  const tools: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(roleFiltered)) {
    if (!t || typeof t !== "object") continue;
    tools[name] = { ...(t as object), needsApproval: false };
  }

  let toolCallIdx = 0;
  for (const [name, t] of Object.entries(tools)) {
    const toolObj = t as Record<string, unknown>;
    const originalExecute = toolObj.execute as
      | ((args: unknown, opts?: { toolCallId?: string }) => Promise<unknown>)
      | undefined;
    if (!originalExecute) continue;
    const isMutation = MUTATION_TOOLS.has(name);

    toolObj.execute = async (
      args: unknown,
      execOpts?: { toolCallId?: string },
    ) => {
      if (jobs.get(jobId)?.controller.signal.aborted) {
        return { error: "Subagent aborted", denied: true, aborted: true };
      }
      const idx = toolCallIdx++;
      const toolCallId = execOpts?.toolCallId ?? `${jobId}-call-${idx}`;
      pushToolStep(jobId, idx, name, args, toolCallId);

      if (permissionMode === "auto-approve") {
        const out = await originalExecute(args, execOpts);
        pushToolResult(jobId, toolCallId, out);
        return out;
      }

      if (permissionMode === "read-only") {
        if (isMutation) {
          const denied = {
            error: `Read-only mode: "${name}" is not allowed.`,
            denied: true,
          };
          pushToolResult(jobId, toolCallId, denied);
          return denied;
        }
        const out = await originalExecute(args, execOpts);
        pushToolResult(jobId, toolCallId, out);
        return out;
      }

      if (isMutation) {
        const policy = resolveToolPolicy(name, permissionMode, args);
        if (policy === "auto-approve") {
          const out = await originalExecute(args, execOpts);
          pushToolResult(jobId, toolCallId, out);
          return out;
        }
        if (policy === "deny") {
          const denied = {
            error: `Denied by permissions: "${name}"`,
            denied: true,
          };
          pushToolResult(jobId, toolCallId, denied);
          return denied;
        }
        const approved = await pushApprovalRequired(jobId, idx, name, args);
        if (!approved) {
          const denied = { denied: true, message: "User denied this tool call." };
          pushToolResult(jobId, toolCallId, denied);
          return denied;
        }
      }
      const out = await originalExecute(args, execOpts);
      pushToolResult(jobId, toolCallId, out);
      return out;
    };
  }

  return tools;
}

async function runSubagent({
  jobId,
  prompt,
  agentType,
  keys,
  modelId,
  thinkingLevel,
  toolContext,
  abortSignal,
}: Args): Promise<Omit<RunResult, "description">> {
  const prefs = usePreferencesStore.getState();
  const model = await buildConfiguredLanguageModel(modelId, keys, {
    lmstudioBaseURL: prefs.lmstudioBaseURL,
    lmstudioModelId: prefs.lmstudioModelId,
    mlxBaseURL: prefs.mlxBaseURL,
    mlxModelId: prefs.mlxModelId,
    ollamaBaseURL: prefs.ollamaBaseURL,
    ollamaModelId: prefs.ollamaModelId,
    openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    openaiCompatibleModelId: prefs.openaiCompatibleModelId,
    openrouterModelId: prefs.openrouterModelId,
  });

  const info = resolveModel(modelId, prefs.customEndpoints);
  const provider = info.provider;

  const baseSystem = agentType
    ? getSubagentSystemPrompt() +
      "\n\n## SPECIALIST ROLE — " +
      agentType +
      "\n" +
      getAgentPrompt(agentType)
    : selectSystemPrompt(modelId);

  const providerOptions = buildThinkingProviderOptions(
    provider,
    thinkingLevel,
    modelId,
  );

  const permissionMode = useChatStore.getState().permissionMode;
  const tools = buildSubagentToolSet(
    toolContext,
    jobId,
    permissionMode,
    agentType,
  );

  const start = Date.now();
  let stepCount = 0;

  const result = streamText({
    model,
    system: baseSystem,
    prompt,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
    abortSignal,
    onChunk: (chunk) => {
      if (abortSignal?.aborted) return;
      if (chunk.chunk.type === "text-delta") {
        pushTextDelta(jobId, chunk.chunk.text);
      }
      if (chunk.chunk.type === "reasoning-delta") {
        pushReasoningDelta(jobId, chunk.chunk.text);
      }
    },
    onStepFinish: (step) => {
      stepCount++;
      // Results are pushed from the execute wrapper (by toolCallId).
      // Keep stepCount only here.
      void step;
    },
  });

  const text = await result.text;
  if (!abortSignal?.aborted) {
    finishSubagent(jobId);
  }

  return {
    summary: text || "(no output)",
    stepCount,
    durationMs: Date.now() - start,
  };
}

export { SUBAGENT_MAX_STEPS, WAIT_TIMEOUT_MS };
