import { streamText, stepCountIs } from "ai";
import { getModel, selectSystemPrompt, type ModelId } from "../config";
import { buildConfiguredLanguageModel } from "../lib/agent";
import { buildThinkingProviderOptions } from "../lib/thinking";
import type { ProviderKeys } from "../lib/keyring";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { buildEditTools } from "../tools/edit";
import { buildShellTools } from "../tools/shell";
import { useChatStore, type PermissionMode } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  pushToolStep,
  pushToolResult,
  pushTextDelta,
  pushReasoningDelta,
  pushApprovalRequired,
  finishSubagent,
} from "./subagentProgress";

// Mutation tools that require approval in "default" and are denied in "read-only".
const MUTATION_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "create_directory",
  "bash_run",
  "bash_background",
  "spawn_coding_agent",
  "send_to_agent",
]);

const SUBAGENT_MAX_STEPS = 12;

type Args = {
  jobId: string;
  prompt: string;
  description?: string;
  keys: ProviderKeys;
  modelId: string;
  toolContext: ToolContext;
};

export type RunResult = {
  description?: string;
  summary: string;
  stepCount: number;
  durationMs: number;
};

// ---- Background job store ----

type JobState = "running" | "done" | "error";

type JobEntry = {
  description?: string;
  status: JobState;
  result?: RunResult;
  error?: string;
  startedAt: number;
  resolve: () => void;
};

const jobs = new Map<string, JobEntry>();

function nextJobId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function spawnSubagent(args: Omit<Args, "jobId">): string {
  const jobId = nextJobId();
  let resolve: () => void = () => {};
  void new Promise<void>((r) => { resolve = r; });

  const entry: JobEntry = {
    description: args.description,
    status: "running",
    startedAt: Date.now(),
    resolve,
  };
  jobs.set(jobId, entry);

  void (async () => {
    try {
      const r = await runSubagent({ ...args, jobId });
      entry.status = "done";
      entry.result = { ...r, description: args.description };
    } catch (e) {
      entry.status = "error";
      entry.error = String(e);
      finishSubagent(jobId, String(e));
    } finally {
      jobs.get(jobId)?.resolve();
    }
  })();

  return jobId;
}

const WAIT_TIMEOUT_MS = 120_000;

export async function waitForSubagents(
  jobIds: string[],
): Promise<(RunResult & { jobId: string; status: JobState; error?: string })[]> {
  const promises = jobIds.map((id) => {
    const entry = jobs.get(id);
    if (!entry) return Promise.resolve(null);
    if (entry.status !== "running") return Promise.resolve(null);
    return new Promise<void>((r) => {
      const orig = entry.resolve;
      entry.resolve = () => { orig(); r(); };
    });
  });

  const timeout = new Promise<void>((r) => setTimeout(r, WAIT_TIMEOUT_MS));
  await Promise.race([Promise.all(promises), timeout]);

  const results: (RunResult & { jobId: string; status: JobState; error?: string })[] = [];
  for (const id of jobIds) {
    const entry = jobs.get(id);
    if (!entry) {
      results.push({ jobId: id, status: "error", error: `unknown job: ${id}`, summary: "", stepCount: 0, durationMs: 0 });
      continue;
    }
    if (entry.status === "running") {
      results.push({ jobId: id, status: "error", error: "timed out", description: entry.description, summary: "", stepCount: 0, durationMs: 0 });
      finishSubagent(id, "timed out");
    } else {
      results.push({ jobId: id, status: entry.status, error: entry.error, ...(entry.result ?? { summary: "", stepCount: 0, durationMs: 0 }) });
    }
    jobs.delete(id);
  }
  return results;
}

// ---- Internal runner — mirrors main agent pipeline ----

/** All tools except run_subagent (prevent recursion), with needsApproval
 *  stripped and execute wrapped with permission-mode-aware approval. */
function buildSubagentToolSet(
  ctx: ToolContext,
  jobId: string,
  permissionMode: PermissionMode,
): Record<string, unknown> {
  const raw = {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildEditTools(ctx),
    ...buildShellTools(ctx),
  };

  // Clone each tool, strip needsApproval.
  const tools: Record<string, unknown> = {};
  for (const [name, t] of Object.entries(raw)) {
    if (!t || typeof t !== "object") continue;
    tools[name] = { ...(t as object), needsApproval: false };
  }

  // Wrap each tool's execute with permission-aware approval logic.
  let toolCallIdx = 0;
  for (const [name, t] of Object.entries(tools)) {
    const toolObj = t as Record<string, unknown>;
    const originalExecute = toolObj.execute as ((args: unknown) => Promise<unknown>) | undefined;
    if (!originalExecute) continue;
    const isMutation = MUTATION_TOOLS.has(name);

    toolObj.execute = async (args: unknown) => {
      const idx = toolCallIdx++;
      pushToolStep(jobId, idx, name, args);

      if (permissionMode === "auto-approve") {
        return originalExecute(args);
      }

      if (permissionMode === "read-only") {
        if (isMutation) {
          return { error: `Read-only mode: "${name}" is not allowed.`, denied: true };
        }
        return originalExecute(args);
      }

      // default mode: require user approval.
      const approved = await pushApprovalRequired(jobId, idx, name, args);
      if (!approved) {
        return { denied: true, message: "User denied this tool call." };
      }
      return originalExecute(args);
    };
  }

  return tools;
}

async function runSubagent({
  jobId,
  prompt,
  keys,
  modelId,
  toolContext,
}: Args): Promise<Omit<RunResult, "description">> {
  // ── Model (same as main agent) ──────────────────────────────────────
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

  const info = getModel(modelId as ModelId);
  const provider = info.provider;

  // ── System prompt (same as main agent) ──────────────────────────────
  const systemPrompt = selectSystemPrompt(modelId);

  // ── Thinking config (same as main agent) ────────────────────────────
  const thinkingLevel = useChatStore.getState().thinkingLevel;
  const providerOptions = buildThinkingProviderOptions(provider, thinkingLevel, modelId);

  // ── Permission mode ─────────────────────────────────────────────────
  const permissionMode = useChatStore.getState().permissionMode;

  // ── Tools (all except run_subagent), with approval wrapping ─────────
  const tools = buildSubagentToolSet(toolContext, jobId, permissionMode);

  const start = Date.now();
  let stepCount = 0;

  // ── Stream (live text pushed to progress store) ────────────────────
  const result = streamText({
    model,
    system: systemPrompt,
    prompt,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    stopWhen: stepCountIs(SUBAGENT_MAX_STEPS),
    onChunk: (chunk) => {
      if (chunk.chunk.type === "text-delta") {
        pushTextDelta(jobId, chunk.chunk.text);
      }
      if (chunk.chunk.type === "reasoning-delta") {
        pushReasoningDelta(jobId, chunk.chunk.text);
      }
    },
    onStepFinish: (step) => {
      stepCount++;
      if (step.toolResults) {
        for (const tr of step.toolResults) {
          pushToolResult(
            jobId,
            tr.toolCallId,
            (tr as { output?: unknown }).output,
            (tr as { errorText?: string }).errorText,
          );
        }
      }
    },
  });

  // Consume the stream to completion.
  const text = await result.text;
  finishSubagent(jobId);

  return {
    summary: text || "(no output)",
    stepCount,
    durationMs: Date.now() - start,
  };
}

export { SUBAGENT_MAX_STEPS };
