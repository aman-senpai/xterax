import { usePreferencesStore } from "@/modules/settings/preferences";
import { generateText, stepCountIs, streamText } from "ai";
import { resolveModel, selectSystemPrompt } from "../config";
import { buildConfiguredLanguageModel } from "../lib/agent";
import type { Agent } from "../lib/agents";
import type { ProviderKeys } from "../lib/keyring";
import {
  filterToolsByAllowlist,
  getEffectivePermissionMode,
  resolveToolPolicy,
} from "../lib/permissions";
import { getAgentPrompt, getSubagentSystemPrompt } from "../lib/prompts";
import {
  buildThinkingProviderOptions,
  type ThinkingLevel,
} from "../lib/thinking";
import { type PermissionMode, useChatStore } from "../store/chatStore";
import type { ToolContext } from "../tools/context";
import { buildEditTools } from "../tools/edit";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { buildShellTools } from "../tools/shell";
import {
  finishSubagent,
  getSubagentState,
  pushApprovalRequired,
  pushReasoningDelta,
  pushTextDelta,
  pushToolResult,
  pushToolStep,
  setSubagentSummary,
} from "./subagentProgress";

/** Hard cap on parallel subagent tasks per run_subagent call. */
export const MAX_SUBAGENT_TASKS = 6;
const SUBAGENT_MAX_STEPS = 12;
const WAIT_TIMEOUT_MS = 180_000;

/** Fallback tool allowlists when only agentType string is provided (run_subagent). */
const ROLE_TOOL_ALLOWLIST: Record<string, string[] | null> = {
  coder: null,
  implement: null,
  architect: ["fs", "search", "todo"],
  reviewer: ["fs", "search"],
  "review-agent": ["fs", "search"],
  security: ["fs", "search"],
  designer: ["fs", "search"],
  design: ["fs", "search"],
  verification: ["fs", "search", "shell", "todo"],
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

/** How the subagent should behave. */
export type SubagentVariant =
  /** Default: implementer; tool-first, short summary. */
  | "implement"
  /** Pipeline review/design/security: investigate briefly, deliver text findings. */
  | "analysis";

type Args = {
  jobId: string;
  prompt: string;
  description?: string;
  /** Legacy role key for run_subagent tool. */
  agentType?: string | null;
  /** Full agent record (pipeline / customized agents). Wins over agentType. */
  agent?: Agent | null;
  /** Behavioral profile. Defaults to implement. */
  variant?: SubagentVariant;
  keys: ProviderKeys;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  toolContext: ToolContext;
  abortSignal?: AbortSignal;
};

const ANALYSIS_SYSTEM = `You are a specialist analysis agent in a multi-agent pipeline.

Your deliverable is TEXT findings for the user and the next agent — not endless exploration.

## Rules (CRITICAL)
1. Prefer grep/glob over reading many files. Target high-signal paths first.
2. At most 4 tool calls for investigation, then you MUST stop calling tools.
3. Your FINAL message must be complete structured markdown findings — that is the product.
4. Do NOT end on a tool call. After tools, write findings with headings and bullet points.
5. Do NOT write only "Let me check…" / "I'll survey…" — those are not findings.
6. Do NOT call write_file/edit. Analysis only.
7. Never thrash listing the same directories. Search, read 1–3 key files, conclude.

## Output format (required)
Use markdown. Include severity/priority when reviewing. Multi-paragraph is expected.`;

const ANALYSIS_MAX_STEPS = 6;

/** True when text looks like real findings, not mid-investigation narration. */
function looksLikeFindings(text: string): boolean {
  const t = text.trim();
  if (t.length < 160) return false;
  // Pure planning/narration without substance
  if (
    /^(i('ll| will)|let me|now i|i'm going|i am going|starting|surveying)/i.test(
      t,
    ) &&
    t.length < 500 &&
    !/\n[-*#]|\n\d+\./.test(t)
  ) {
    return false;
  }
  // Prefer structured content
  if (/\n[-*#]|\n\d+\.|MUST|SHOULD|## |severity|recommend/i.test(t)) {
    return true;
  }
  return t.length >= 400;
}

function digestToolSteps(
  steps: Array<{ toolName: string; input: unknown; output?: unknown }>,
): string {
  const lines: string[] = [];
  for (const s of steps.slice(0, 12)) {
    const input =
      typeof s.input === "object" && s.input
        ? JSON.stringify(s.input).slice(0, 180)
        : String(s.input ?? "");
    let out = "";
    if (s.output !== undefined) {
      out =
        typeof s.output === "string"
          ? s.output.slice(0, 600)
          : JSON.stringify(s.output).slice(0, 600);
    }
    lines.push(`### ${s.toolName}\ninput: ${input}\noutput: ${out}`);
  }
  return lines.join("\n\n") || "(no tool results)";
}

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

function stripWritingMarker(text: string): string {
  return text
    .replace(/\n*_Writing findings[^*]*_?\s*$/gi, "")
    .replace(/^_Writing findings[^*]*_?\s*/gi, "")
    .trim();
}

export function spawnSubagent(
  args: Omit<Args, "jobId" | "abortSignal">,
): string {
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
      // Prefer a real summary over a late abort (e.g. timeout during synthesis).
      const hasSummary =
        Boolean(r.summary?.trim()) && r.summary !== "(no output)";
      if (controller.signal.aborted && !hasSummary) {
        entry.status = "aborted";
        entry.error = "aborted";
        entry.result = { ...r, description: args.description };
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
      const partial = stripWritingMarker(
        getSubagentState(jobId)?.text?.trim() ?? "",
      );
      if (partial && partial !== "(no output)") {
        entry.status = "done";
        entry.result = {
          description: args.description,
          summary: partial,
          stepCount: 0,
          durationMs: Date.now() - entry.startedAt,
        };
        finishSubagent(jobId);
        setSubagentSummary(jobId, { status: "done", text: partial });
      } else {
        entry.status = aborted ? "aborted" : "error";
        entry.error = aborted ? "aborted" : msg;
        finishSubagent(jobId, entry.error);
      }
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

function roleAllowlist(
  agent?: Agent | null,
  agentType?: string | null,
): string[] | null {
  if (agent) return agent.toolAllowlist;
  if (!agentType) return null;
  return ROLE_TOOL_ALLOWLIST[agentType] ?? null;
}

/** All tools except run_subagent (prevent recursion), with needsApproval
 *  stripped and execute wrapped with permission-mode-aware approval. */
function buildSubagentToolSet(
  ctx: ToolContext,
  jobId: string,
  permissionMode: PermissionMode,
  agent?: Agent | null,
  agentType?: string | null,
): Record<string, unknown> {
  const raw = {
    ...buildFsTools(ctx),
    ...buildSearchTools(ctx),
    ...buildEditTools(ctx),
    ...buildShellTools(ctx),
  };

  // Specialist roles / agent allowlists reduce the tool surface.
  const roleFiltered = filterToolsByAllowlist(
    raw,
    roleAllowlist(agent, agentType),
  );

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
          const denied = {
            denied: true,
            message: "User denied this tool call.",
          };
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

function resolveVariant(
  variant: SubagentVariant | undefined,
  agent?: Agent | null,
  agentType?: string | null,
): SubagentVariant {
  if (variant) return variant;
  const handle = agent?.handle ?? agentType ?? "";
  const analysis = new Set([
    "architect",
    "reviewer",
    "review-agent",
    "security",
    "designer",
    "design",
  ]);
  return analysis.has(handle) ? "analysis" : "implement";
}

async function runSubagent({
  jobId,
  prompt,
  agentType,
  agent,
  variant: variantOpt,
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
  const variant = resolveVariant(variantOpt, agent, agentType);

  let baseSystem: string;
  if (variant === "analysis") {
    const persona = agent
      ? agent.builtIn
        ? getAgentPrompt(agent.id.replace("builtin:", ""))
        : agent.instructions
      : agentType
        ? getAgentPrompt(agentType)
        : "";
    baseSystem =
      ANALYSIS_SYSTEM +
      (persona
        ? `\n\n## SPECIALIST ROLE — ${agent?.name ?? agentType}\n${persona}`
        : "");
  } else if (agent) {
    const persona = agent.builtIn
      ? getAgentPrompt(agent.id.replace("builtin:", ""))
      : agent.instructions;
    baseSystem =
      getSubagentSystemPrompt() +
      `\n\n## SPECIALIST AGENT — ${agent.name} (@${agent.handle})\n` +
      persona;
  } else if (agentType) {
    baseSystem =
      getSubagentSystemPrompt() +
      "\n\n## SPECIALIST ROLE — " +
      agentType +
      "\n" +
      getAgentPrompt(agentType);
  } else {
    baseSystem = selectSystemPrompt(modelId);
  }

  const providerOptions = buildThinkingProviderOptions(
    provider,
    thinkingLevel,
    modelId,
  );

  const permissionMode = getEffectivePermissionMode(
    useChatStore.getState().permissionMode,
  );
  const tools = buildSubagentToolSet(
    toolContext,
    jobId,
    permissionMode,
    agent,
    agentType,
  );

  const start = Date.now();
  let stepCount = 0;
  const maxSteps =
    variant === "analysis" ? ANALYSIS_MAX_STEPS : SUBAGENT_MAX_STEPS;

  const result = streamText({
    model,
    system: baseSystem,
    prompt,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    stopWhen: stepCountIs(maxSteps),
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

  let text = (await result.text)?.trim() ?? "";
  // Prefer model text; fall back to streamed progress (tool-only turns often
  // leave result.text empty even though work completed).
  const streamed = getSubagentState(jobId)?.text?.trim() ?? "";
  if (!text) text = streamed;
  text = stripWritingMarker(text);

  // Analysis agents often stop after a tool call with only "Let me check…"
  // narration. Force a no-tools conclusion pass so the pipeline has findings.
  //
  // Important: do NOT attach abortSignal here. A parent timeout/abort mid
  // conclusion used to leave status=aborted with "_Writing findings…_" stuck
  // in the card and no summary for the next agent. Conclusion is short; if the
  // user stops the pipeline we still prefer best-effort findings over abort.
  if (
    variant === "analysis" &&
    !abortSignal?.aborted &&
    !looksLikeFindings(text)
  ) {
    const prog = getSubagentState(jobId);
    const digest = digestToolSteps(prog?.steps ?? []);
    const notesOnly = text;
    try {
      setSubagentSummary(jobId, {
        status: "running",
        text: notesOnly
          ? `${notesOnly}\n\n_Writing findings…_`
          : "_Writing findings from investigation…_",
      });
      const conclusion = await generateText({
        model,
        system: baseSystem,
        prompt: [
          "Investigation is finished. Do NOT call tools.",
          "Write your COMPLETE structured findings for the user and next agent now.",
          "",
          "## Original task",
          prompt,
          "",
          "## Tool results (use these)",
          digest,
          "",
          notesOnly
            ? `## Notes so far (expand into full findings; drop filler)\n${notesOnly}`
            : "Write full findings from the tool results above.",
        ].join("\n"),
      });
      const findings = conclusion.text?.trim() ?? "";
      if (findings) text = findings;
      else if (!text) text = digest.slice(0, 2000);
    } catch (e) {
      text = stripWritingMarker(text);
      if (!looksLikeFindings(text)) {
        const err = e instanceof Error ? e.message : String(e);
        text = [
          notesOnly || "Investigation finished.",
          "",
          `_Findings synthesis failed (${err}). Tool digest:_`,
          "",
          digest.slice(0, 1500),
        ].join("\n");
      }
    }
  }

  text = stripWritingMarker(text).trim();

  // Always finalize as done when we produced a summary so the next pipeline
  // step receives it — even if the user aborted mid-conclusion.
  finishSubagent(jobId, text ? undefined : "no output");
  if (text) setSubagentSummary(jobId, { status: "done", text });

  return {
    summary: text || "(no output)",
    stepCount,
    durationMs: Date.now() - start,
  };
}

export { SUBAGENT_MAX_STEPS, WAIT_TIMEOUT_MS };
