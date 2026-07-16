import type { AcpAgentConfig } from "@/modules/acp/types";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { UIMessage } from "@ai-sdk/react";
import type { Agent, PipelineStep } from "../lib/agents";
import {
  type CompiledNode,
  type CompiledProgram,
  type PipelineDisplayNode,
  toDisplayNodes,
} from "../lib/pipelineCompile";
import type { BreakCond } from "../lib/pipelineDsl";
import {
  type BodyStepSnapshot,
  formatLoopBreakNote,
  isVerifierHandle,
  loopOutcomeInstruction,
  resolveBodyOutcome,
  shouldBreakLoop,
} from "../lib/pipelineOutcome";
import type { ThinkingLevel } from "../lib/thinking";
import { useAgentsStore } from "../store/agentsStore";
import { getOrCreateChat } from "../store/chatRuntime";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "../tools/context";
import {
  abortSubagent,
  type RunResult,
  spawnSubagent,
  waitForSubagents,
} from "./runSubagent";
import {
  getSubagentState,
  registerBatch,
  setSubagentSummary,
} from "./subagentProgress";

export type PipelineStepResult = RunResult & {
  kind: "local" | "acp";
  handle: string;
  name: string;
  status: "done" | "error" | "aborted";
  error?: string;
  /** Loop context when this run was inside a loop. */
  loopId?: string;
  loopIter?: number;
  loopMax?: number;
};

export type PipelineResult = {
  steps: PipelineStepResult[];
  aborted: boolean;
  error?: string;
  broke?: boolean;
};

type TaskSpec = { description: string; prompt: string };
type ResultSpec = {
  description: string;
  status: string;
  summary: string;
  stepCount: number;
  durationMs: number;
  error?: string;
  loopId?: string;
  loopIter?: number;
  loopMax?: number;
};

/** Runtime path entry for UI (each agent invocation). */
export type PipelineRunEntry = {
  handle: string;
  name: string;
  kind: "local" | "acp";
  loopId?: string;
  loopIter?: number;
  loopMax?: number;
  status?: "pending" | "running" | "done" | "error" | "aborted" | "skipped";
};

/** Synthetic tool part so AiChat renders SubagentCards + pipeline chrome. */
type PipelineToolPart = {
  type: "tool-run_subagent";
  toolCallId: string;
  state:
    | "input-streaming"
    | "input-available"
    | "output-available"
    | "output-error";
  input: {
    tasks: TaskSpec[];
    pipeline?: {
      /** Nested program structure (loops visible). */
      structure: PipelineDisplayNode[];
      /** Flat execution path so far. */
      runPath: PipelineRunEntry[];
      activeIndex: number;
      breakNote?: string | null;
    };
  };
  output?: { results: ResultSpec[]; allDone?: boolean };
  errorText?: string;
};

let pipelineController: AbortController | null = null;

export function abortPipeline(): void {
  pipelineController?.abort();
  abortSubagent();
  void import("@/modules/acp").then(({ useAcpStore }) => {
    const store = useAcpStore.getState();
    for (const chatId of Object.keys(store.bindings)) {
      if (chatId.startsWith("pipe-acp:")) {
        void store.cancel(chatId);
      }
    }
  });
  pipelineController = null;
}

function resolveAgentModel(agent: Agent): {
  modelId: string;
  thinkingLevel: ThinkingLevel;
} {
  const prefs = usePreferencesStore.getState();
  const session = useChatStore.getState();
  const modelId =
    agent.modelId?.trim() || prefs.subagentModelId || session.selectedModelId;
  const thinkingLevel =
    agent.thinkingLevel ?? prefs.subagentThinkingLevel ?? session.thinkingLevel;
  return { modelId, thinkingLevel };
}

function makeToolContext(sessionId: string): ToolContext {
  const readCache = new Map<string, { size: number; hash: number }>();
  return {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getProjectRoot: () => useChatStore.getState().live.getProjectRoot(),
    getTerminalContext: () => useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
    spawnAgent: (prompt) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
    readAgentOutput: (leafId) =>
      useChatStore.getState().live.readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
  };
}

function setChatMessages(sessionId: string, messages: UIMessage[]): void {
  const chat = getOrCreateChat(sessionId);
  chat.messages = messages;
  useChatStore.getState().persistMessages(sessionId, messages);
}

function getChatMessages(sessionId: string): UIMessage[] {
  return [...(getOrCreateChat(sessionId).messages as UIMessage[])];
}

function stepLabel(step: PipelineStep): { handle: string; name: string } {
  if (step.kind === "local") {
    return { handle: step.agent.handle, name: step.agent.name };
  }
  return { handle: step.handle, name: step.config.name };
}

function cleanFindingsText(text: string): string {
  return text
    .replace(/\n*_Writing findings[^*]*_?\s*$/gi, "")
    .replace(/^_Writing findings[^*]*_?\s*/gi, "")
    .trim();
}

function summarizeLocalStep(
  jobId: string,
  r: { summary?: string; error?: string },
): string {
  const prog = getSubagentState(jobId);
  const text = cleanFindingsText((r.summary ?? "").trim());
  if (text && text !== "(no output)") return text;
  const streamed = cleanFindingsText(prog?.text?.trim() ?? "");
  if (streamed) return streamed;
  if (prog?.steps?.length) {
    return [
      "Completed tool work:",
      ...prog.steps.map((s) => `- \`${s.toolName}\` (${s.state})`),
    ].join("\n");
  }
  if (r.error) return `Error: ${r.error}`;
  return "(no text output)";
}

type LoopRunCtx = {
  loopId: string;
  iter: number;
  max: number;
  breakWhen: BreakCond | null;
};

function buildHandoff(opts: {
  userBody: string;
  prior: PipelineStepResult[];
  handle: string;
  name: string;
  stepIndex: number;
  totalHint: string;
  loop?: LoopRunCtx;
}): string {
  const { handle, name } = opts;
  const roleHint =
    handle === "reviewer" || handle === "review-agent" || handle === "security"
      ? "Perform a security-aware code review. List concrete findings with severity and fix guidance. Do not implement the fix."
      : handle === "architect"
        ? "Produce an architecture/design plan for the requested fix. Use prior results. Do not implement code."
        : handle === "coder" || handle === "implement"
          ? "Implement the requested changes based on prior review/design."
          : handle === "verification"
            ? "Run project checks and report what passed/failed. You MUST end with a structured PIPELINE_OUTCOME line."
            : handle === "designer" || handle === "design"
              ? "Critique UI/UX and propose concrete design changes."
              : `Apply your ${name} specialist role to the user request.`;

  const lines: string[] = [
    `You are @${handle} (${name}) — ${opts.totalHint}.`,
    "",
    "## User request",
    opts.userBody.trim() || "(no additional text)",
    "",
    "## Your job this step (do this only)",
    roleHint,
    "",
    "Investigate with a few targeted tool calls (grep/glob first), then write your full findings as markdown text.",
    "Do not thrash reading the same files. Cap exploration; conclusions matter more than coverage.",
  ];

  if (opts.prior.length > 0) {
    lines.push("", "## Prior results (use these; do not redo their work)");
    for (const p of opts.prior) {
      const loop =
        p.loopId != null
          ? ` · ${p.loopId} iter ${p.loopIter}/${p.loopMax}`
          : "";
      lines.push(
        "",
        `### @${p.handle} (${p.name}) — ${p.status}${loop}`,
        p.summary || p.error || "(no output)",
      );
    }
  }

  lines.push("", "END by writing a complete structured answer.");

  if (opts.loop) {
    lines.push(
      "",
      loopOutcomeInstruction({
        loopId: opts.loop.loopId,
        iter: opts.loop.iter,
        max: opts.loop.max,
        breakWhen: opts.loop.breakWhen,
        isVerifier: isVerifierHandle(handle),
      }),
    );
  } else if (isVerifierHandle(handle)) {
    lines.push(
      "",
      "When reporting check results, end with exactly one of:",
      "PIPELINE_OUTCOME: pass",
      "PIPELINE_OUTCOME: fail",
    );
  }

  return lines.join("\n");
}

function writePipelineToolMessage(
  sessionId: string,
  messageId: string,
  toolCallId: string,
  opts: {
    tasks: TaskSpec[];
    structure: PipelineDisplayNode[];
    runPath: PipelineRunEntry[];
    activeIndex: number;
    breakNote?: string | null;
    results?: ResultSpec[];
    state: PipelineToolPart["state"];
    errorText?: string;
  },
): void {
  const toolPart: PipelineToolPart = {
    type: "tool-run_subagent",
    toolCallId,
    state: opts.state,
    input: {
      tasks: opts.tasks,
      pipeline: {
        structure: opts.structure,
        runPath: opts.runPath,
        activeIndex: opts.activeIndex,
        breakNote: opts.breakNote ?? null,
      },
    },
    ...(opts.results
      ? {
          output: {
            results: opts.results,
            allDone: opts.state === "output-available",
          },
        }
      : {}),
    ...(opts.errorText ? { errorText: opts.errorText } : {}),
  };

  const msg: UIMessage = {
    id: messageId,
    role: "assistant",
    parts: [toolPart as unknown as UIMessage["parts"][number]],
  };

  const messages = getChatMessages(sessionId);
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    setChatMessages(sessionId, [...messages, msg]);
  } else {
    const next = messages.slice();
    next[idx] = msg;
    setChatMessages(sessionId, next);
  }
}

function transcriptToSummary(
  messages: Array<{
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>,
): string {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "text" && p.text?.trim()) texts.push(p.text.trim());
    }
  }
  return texts.join("\n\n") || "(no output)";
}

async function runAcpStep(opts: {
  parentSessionId: string;
  handle: string;
  config: AcpAgentConfig;
  prompt: string;
  signal: AbortSignal;
}): Promise<{ summary: string; error?: string; aborted?: boolean }> {
  const { useAcpStore } = await import("@/modules/acp");
  const prefs = usePreferencesStore.getState();
  const store = useChatStore.getState();
  const cwd =
    store.live.getWorkspaceRoot() ||
    store.live.getProjectRoot() ||
    store.live.getCwd();
  if (!cwd) {
    return { summary: "", error: "No workspace directory for ACP session" };
  }

  const pipeChatId = `pipe-acp:${opts.parentSessionId}:${opts.config.id}:${Date.now().toString(36)}`;
  const acp = useAcpStore.getState();
  if (opts.signal.aborted) return { summary: "", aborted: true };

  try {
    await acp.ensureSession({
      chatSessionId: pipeChatId,
      config: opts.config,
      cwd,
      mcpServers: prefs.mcpServers,
    });
    if (opts.signal.aborted) {
      await acp.cancel(pipeChatId);
      acp.clearBinding(pipeChatId);
      return { summary: "", aborted: true };
    }
    const onAbort = () => {
      void acp.cancel(pipeChatId);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await acp.sendPrompt(pipeChatId, opts.prompt);
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
    if (opts.signal.aborted) {
      acp.clearBinding(pipeChatId);
      return { summary: "", aborted: true };
    }
    const transcript = useAcpStore.getState().getTranscript(pipeChatId);
    const summary = transcriptToSummary(transcript);
    acp.clearBinding(pipeChatId);
    return { summary };
  } catch (e) {
    try {
      useAcpStore.getState().clearBinding(pipeChatId);
    } catch {
      /* ignore */
    }
    if (opts.signal.aborted) return { summary: "", aborted: true };
    return {
      summary: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

type RunCtx = {
  sessionId: string;
  messageId: string;
  toolCallId: string;
  userBody: string;
  structure: PipelineDisplayNode[];
  controller: AbortSignal;
  toolContext: ToolContext;
  apiKeys: ReturnType<typeof useChatStore.getState>["apiKeys"];
  tasks: TaskSpec[];
  batchJobs: Array<{ jobId: string; desc: string }>;
  results: PipelineStepResult[];
  resultSpecs: ResultSpec[];
  runPath: PipelineRunEntry[];
  breakNote: string | null;
};

function paint(
  ctx: RunCtx,
  state: PipelineToolPart["state"] = "input-available",
  errorText?: string,
) {
  writePipelineToolMessage(ctx.sessionId, ctx.messageId, ctx.toolCallId, {
    tasks: [...ctx.tasks],
    structure: ctx.structure,
    runPath: [...ctx.runPath],
    activeIndex: Math.max(0, ctx.runPath.length - 1),
    breakNote: ctx.breakNote,
    results:
      state === "output-available" || state === "output-error"
        ? [...ctx.resultSpecs]
        : undefined,
    state,
    errorText,
  });
}

async function runOneAgent(
  ctx: RunCtx,
  node: Extract<CompiledNode, { type: "agent" }>,
  loop?: LoopRunCtx,
): Promise<"ok" | "error" | "aborted"> {
  const { handle, name, step: stepSpec } = node;
  const loopTag = loop ? ` · ${loop.loopId} ${loop.iter}/${loop.max}` : "";
  const desc = `@${handle} · ${name}${stepSpec.kind === "acp" ? " · ACP" : ""}${loopTag}`;

  const runEntry: PipelineRunEntry = {
    handle,
    name,
    kind: stepSpec.kind === "acp" ? "acp" : "local",
    loopId: loop?.loopId,
    loopIter: loop?.iter,
    loopMax: loop?.max,
    status: "running",
  };
  ctx.runPath.push(runEntry);
  useChatStore.getState().patchAgentMeta({
    status: "streaming",
    step: `@${handle}${loopTag}`,
  });

  const prompt = buildHandoff({
    userBody: ctx.userBody,
    prior: ctx.results,
    handle,
    name,
    stepIndex: ctx.runPath.length,
    totalHint: `pipeline step ${ctx.runPath.length}`,
    loop,
  });

  ctx.tasks.push({ description: desc, prompt });

  if (stepSpec.kind === "acp") {
    const fakeJobId = `acp-pipe-${ctx.runPath.length}-${Date.now().toString(36)}`;
    ctx.batchJobs.push({ jobId: fakeJobId, desc });
    registerBatch([...ctx.batchJobs]);
    setSubagentSummary(fakeJobId, {
      status: "running",
      text: "Running ACP agent…",
    });
    paint(ctx);

    const start = Date.now();
    const r = await runAcpStep({
      parentSessionId: ctx.sessionId,
      handle,
      config: stepSpec.config as AcpAgentConfig,
      prompt,
      signal: ctx.controller,
    });
    const status: PipelineStepResult["status"] = r.aborted
      ? "aborted"
      : r.error
        ? "error"
        : "done";
    const summary = r.summary || "(no output)";
    setSubagentSummary(fakeJobId, {
      status: status === "done" ? "done" : "error",
      text: summary,
      error: r.error,
    });
    const step: PipelineStepResult = {
      kind: "acp",
      handle,
      name,
      status,
      summary,
      stepCount: 0,
      durationMs: Date.now() - start,
      error: r.error,
      loopId: loop?.loopId,
      loopIter: loop?.iter,
      loopMax: loop?.max,
    };
    ctx.results.push(step);
    ctx.resultSpecs.push({
      description: desc,
      status,
      summary,
      stepCount: 0,
      durationMs: step.durationMs,
      error: r.error,
      loopId: loop?.loopId,
      loopIter: loop?.iter,
      loopMax: loop?.max,
    });
    runEntry.status = status;
    paint(ctx);
    if (status === "aborted") return "aborted";
    if (status === "error") return "error";
    return "ok";
  }

  // Local agent
  const agent = stepSpec.agent;
  const live =
    useAgentsStore
      .getState()
      .all()
      .find((a) => a.id === agent.id) ?? agent;
  const { modelId, thinkingLevel } = resolveAgentModel(live);
  const analysisRoles = new Set([
    "architect",
    "reviewer",
    "review-agent",
    "security",
    "designer",
    "design",
    "verification",
  ]);

  const jobId = spawnSubagent({
    prompt,
    description: desc,
    agent: live,
    agentType: live.handle,
    variant: analysisRoles.has(live.handle) ? "analysis" : "implement",
    keys: ctx.apiKeys,
    modelId,
    thinkingLevel,
    toolContext: ctx.toolContext,
  });
  ctx.batchJobs.push({ jobId, desc });
  registerBatch([...ctx.batchJobs]);
  paint(ctx);

  const onAbort = () => abortSubagent(jobId);
  ctx.controller.addEventListener("abort", onAbort, { once: true });
  const waited = await waitForSubagents([jobId]);
  ctx.controller.removeEventListener("abort", onAbort);

  const r = waited[0];
  const summary = summarizeLocalStep(jobId, {
    summary: r?.summary,
    error: r?.error,
  });
  const hasSummary =
    Boolean(summary) &&
    summary !== "(no text output)" &&
    summary !== "(no output)";
  const status: PipelineStepResult["status"] =
    r?.status === "done" || (hasSummary && r?.status !== "error")
      ? "done"
      : r?.status === "aborted"
        ? "aborted"
        : "error";

  const step: PipelineStepResult = {
    kind: "local",
    handle: live.handle,
    name: live.name,
    status,
    summary,
    stepCount: r?.stepCount ?? 0,
    durationMs: r?.durationMs ?? 0,
    error: status === "done" ? undefined : r?.error,
    loopId: loop?.loopId,
    loopIter: loop?.iter,
    loopMax: loop?.max,
  };
  ctx.results.push(step);
  ctx.resultSpecs.push({
    description: desc,
    status,
    summary,
    stepCount: step.stepCount,
    durationMs: step.durationMs,
    error: step.error,
    loopId: loop?.loopId,
    loopIter: loop?.iter,
    loopMax: loop?.max,
  });
  runEntry.status = status;
  paint(ctx);

  if (status === "aborted") return "aborted";
  if (status === "error") return "error";
  return "ok";
}

/**
 * Run a sequence of nodes at top level (outside a loop body).
 * Agent errors fail the pipeline. Nested loops absorb body errors and only
 * propagate user abort.
 */
async function execNodes(
  ctx: RunCtx,
  nodes: CompiledNode[],
): Promise<"ok" | "error" | "aborted"> {
  for (const node of nodes) {
    if (ctx.controller.aborted) return "aborted";

    if (node.type === "agent") {
      const r = await runOneAgent(ctx, node);
      if (r !== "ok") return r;
      continue;
    }

    const loopResult = await execLoop(ctx, node);
    if (loopResult === "aborted") return "aborted";
  }
  return "ok";
}

/**
 * Run one loop body iteration.
 * - User abort → aborted
 * - Step error → stop remaining body agents this iter (outcome becomes fail
 *   unless a later step already ran with an explicit signal)
 * - Nested loops → recursive; absorb their non-abort results
 */
async function execLoopBody(
  ctx: RunCtx,
  body: CompiledNode[],
  loop: LoopRunCtx,
): Promise<"complete" | "aborted"> {
  for (const node of body) {
    if (ctx.controller.aborted) return "aborted";

    if (node.type === "agent") {
      const r = await runOneAgent(ctx, node, loop);
      if (r === "aborted") return "aborted";
      // Absorb errors: do not run further agents this iteration.
      // Synthetic fail is applied by resolveBodyOutcome when no signal.
      if (r === "error") return "complete";
      continue;
    }

    // Nested loop
    const nested = await execLoop(ctx, node);
    if (nested === "aborted") return "aborted";
  }
  return "complete";
}

/**
 * Agentic loop: for iter in 1..max, run body, resolve structured outcome,
 * break when breakWhen matches. Never fails the outer pipeline for body
 * step errors — those become fail outcomes for break-if-fail / continue.
 */
async function execLoop(
  ctx: RunCtx,
  node: Extract<CompiledNode, { type: "loop" }>,
): Promise<"ok" | "aborted"> {
  let lastOutcome = resolveBodyOutcome([]);

  for (let iter = 1; iter <= node.max; iter++) {
    if (ctx.controller.aborted) return "aborted";

    const loopCtx: LoopRunCtx = {
      loopId: node.loopId,
      iter,
      max: node.max,
      breakWhen: node.breakWhen,
    };

    const bodyStart = ctx.results.length;
    const bodyRun = await execLoopBody(ctx, node.body, loopCtx);
    if (bodyRun === "aborted") return "aborted";

    const bodySteps: BodyStepSnapshot[] = ctx.results
      .slice(bodyStart)
      .map((s) => ({
        handle: s.handle,
        status: s.status,
        summary: s.summary ?? s.error ?? "",
      }));

    lastOutcome = resolveBodyOutcome(bodySteps);
    if (lastOutcome.kind === "aborted") return "aborted";

    const broke = shouldBreakLoop(node.breakWhen, lastOutcome);
    const atMax = iter === node.max;

    if (broke || atMax) {
      ctx.breakNote = formatLoopBreakNote({
        loopId: node.loopId,
        iter,
        max: node.max,
        breakWhen: node.breakWhen,
        outcome: lastOutcome,
        broke,
        atMax: atMax && !broke,
      });
      paint(ctx);
    }

    if (broke) break;
  }

  return "ok";
}

/**
 * Run a compiled pipeline program (supports chains + loops + break).
 * Also accepts a flat `steps` list for backward compatibility.
 */
export async function runAgentPipeline(opts: {
  sessionId: string;
  compiled?: CompiledProgram;
  steps?: PipelineStep[];
  agents?: Agent[];
  userBody: string;
  userParts: Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; url: string; filename?: string }
  >;
}): Promise<PipelineResult> {
  let compiled = opts.compiled;
  if (!compiled) {
    const flat: PipelineStep[] =
      opts.steps ??
      (opts.agents ?? []).map((agent) => ({ kind: "local" as const, agent }));
    if (flat.length === 0) {
      return { steps: [], aborted: false, error: "No agents to run" };
    }
    compiled = {
      body: opts.userBody,
      maxRuns: flat.length,
      nodes: flat.map((step) => {
        const l = stepLabel(step);
        return {
          type: "agent" as const,
          step,
          handle: l.handle,
          name: l.name,
        };
      }),
    };
  }

  const { sessionId, userParts } = opts;
  const userBody = opts.userBody || compiled.body;

  abortPipeline();
  const controller = new AbortController();
  pipelineController = controller;

  const store = useChatStore.getState();
  store.patchAgentMeta({
    status: "streaming",
    error: null,
    hitStepCap: false,
    compactionNotice: null,
    step: "Pipeline starting…",
  });
  if (!store.rightPanelOpen) store.openRightPanel();

  const displayText =
    userParts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n") || userBody;

  const userMsg: UIMessage = {
    id: `u-pipe-${Date.now().toString(36)}`,
    role: "user",
    parts: userParts.length
      ? (userParts as UIMessage["parts"])
      : [{ type: "text", text: displayText }],
  };
  setChatMessages(sessionId, [...getChatMessages(sessionId), userMsg]);

  const messageId = `a-pipe-${Date.now().toString(36)}`;
  const toolCallId = `pipe-tool-${Date.now().toString(36)}`;
  const structure = toDisplayNodes(compiled.nodes);

  const ctx: RunCtx = {
    sessionId,
    messageId,
    toolCallId,
    userBody,
    structure,
    controller: controller.signal,
    toolContext: makeToolContext(sessionId),
    apiKeys: useChatStore.getState().apiKeys,
    tasks: [],
    batchJobs: [],
    results: [],
    resultSpecs: [],
    runPath: [],
    breakNote: null,
  };

  paint(ctx);

  try {
    const outcome = await execNodes(ctx, compiled.nodes);
    if (outcome === "aborted") {
      paint(ctx, "output-available");
      store.patchAgentMeta({ status: "idle", step: null });
      return {
        steps: ctx.results,
        aborted: true,
        broke: Boolean(ctx.breakNote),
      };
    }
    if (outcome === "error") {
      const last = ctx.results[ctx.results.length - 1];
      const err = last?.error ?? "Pipeline step failed";
      paint(ctx, "output-error", err);
      store.patchAgentMeta({
        status: "error",
        error: err,
        step: null,
      });
      return {
        steps: ctx.results,
        aborted: false,
        error: err,
      };
    }
    paint(ctx, "output-available");
    store.patchAgentMeta({ status: "idle", step: null });
    return {
      steps: ctx.results,
      aborted: false,
      broke: Boolean(ctx.breakNote),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    paint(ctx, "output-error", msg);
    store.patchAgentMeta({ status: "error", error: msg, step: null });
    return { steps: ctx.results, aborted: false, error: msg };
  } finally {
    if (pipelineController === controller) pipelineController = null;
  }
}
