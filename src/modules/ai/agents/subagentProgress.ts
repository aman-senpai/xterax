export type SubagentStreamState = {
  status: "running" | "done" | "error";
  text: string;
  steps: Array<{
    toolName: string;
    input: unknown;
    output?: unknown;
    state: "pending" | "done" | "error" | "awaiting-approval" | "denied";
    errorText?: string;
    toolCallId?: string;
  }>;
  reasoning: string;
  error?: string;
  startedAt: number;
  /** Pending approvals waiting for user response. */
  pendingApprovals: PendingApproval[];
};

export type PendingApproval = {
  stepIndex: number;
  toolName: string;
  input: unknown;
};

// ── Global singleton — all mutable state lives on globalThis so bundler
//    code-splitting cannot create separate module instances. If it did,
//    finishSubagent would write to one `state` Map while getSubagentState
//    reads from another, and getProgressVersion would return a version
//    that never matches what notify() increments. ──────────────────────────
const GLOBAL_KEY = "__xterax_subagent_progress_store__";

type GlobalStore = {
  bus: EventTarget;
  state: Map<string, SubagentStreamState>;
  approvalResolvers: Map<string, Map<number, (approved: boolean) => void>>;
  currentBatch: Array<{ jobId: string; desc: string }>;
  tick: number;
};

function getStore(): GlobalStore {
  const _g = globalThis as Record<string, unknown>;
  let s = _g[GLOBAL_KEY] as GlobalStore | undefined;
  if (!s) {
    s = {
      bus: new EventTarget(),
      state: new Map(),
      approvalResolvers: new Map(),
      currentBatch: [],
      tick: 0,
    };
    _g[GLOBAL_KEY] = s;
  }
  return s;
}

const EVT = "progress";

export function registerBatch(tasks: Array<{ jobId: string; desc: string }>) {
  const store = getStore();
  store.currentBatch = tasks;
  // Eagerly create progress-store entries so getSubagentState never
  // returns null — cards render with real state from the first frame.
  for (const t of tasks) {
    if (!store.state.has(t.jobId)) {
      store.state.set(t.jobId, {
        status: "running",
        text: "",
        steps: [],
        reasoning: "",
        startedAt: Date.now(),
        pendingApprovals: [],
      });
    }
  }
  notify();
}

export function getCurrentBatch(): Array<{ jobId: string; desc: string }> {
  return getStore().currentBatch;
}

export function getProgressVersion(): number {
  return getStore().tick;
}

/** Subscribe using the global EventTarget — immune to module duplication. */
export function subscribeProgress(cb: () => void): () => void {
  const { bus } = getStore();
  bus.addEventListener(EVT, cb);
  return () => bus.removeEventListener(EVT, cb);
}

function notify() {
  const store = getStore();
  store.tick++;
  store.bus.dispatchEvent(new Event(EVT));
}

function getOrCreate(jobId: string): SubagentStreamState {
  const store = getStore();
  let s = store.state.get(jobId);
  if (!s) {
    s = {
      status: "running",
      text: "",
      steps: [],
      reasoning: "",
      startedAt: Date.now(),
      pendingApprovals: [],
    };
    store.state.set(jobId, s);
  }
  return s;
}

export function pushTextDelta(jobId: string, delta: string) {
  const s = getOrCreate(jobId);
  s.text += delta;
  notify();
}

export function pushReasoningDelta(jobId: string, delta: string) {
  const s = getOrCreate(jobId);
  s.reasoning += delta;
  notify();
}

/** Record a tool step at a specific index (used by wrapped execute —
 *  called once per tool call from the wrapper, not from onStepFinish). */
export function pushToolStep(
  jobId: string,
  stepIndex: number,
  toolName: string,
  input: unknown,
  toolCallId?: string,
) {
  const s = getOrCreate(jobId);
  while (s.steps.length <= stepIndex) {
    s.steps.push({ toolName, input, state: "pending" });
  }
  s.steps[stepIndex] = {
    toolName,
    input,
    state: "pending",
    toolCallId,
  };
  notify();
}

export function pushToolCall(
  jobId: string,
  _toolCallId: string,
  toolName: string,
  input: unknown,
) {
  const s = getOrCreate(jobId);
  s.steps.push({ toolName, input, state: "pending" });
  notify();
}

export function pushToolResult(
  jobId: string,
  toolCallId: string,
  output: unknown,
  errorText?: string,
) {
  const s = getOrCreate(jobId);
  // Prefer exact toolCallId match so parallel tool calls attribute correctly.
  let step = toolCallId
    ? s.steps.find((st) => st.toolCallId === toolCallId)
    : undefined;
  if (!step) {
    step = s.steps.find(
      (st) => st.state === "pending" || st.state === "awaiting-approval",
    );
  }
  if (step) {
    step.output = output;
    const denied =
      output &&
      typeof output === "object" &&
      (output as { denied?: boolean }).denied === true;
    step.state = errorText ? "error" : denied ? "denied" : "done";
    step.errorText = errorText;
  }
  notify();
}

/** Mark an already-registered tool step as awaiting approval. The step
 *  entry must already exist (created by pushToolStep). Stores a resolver
 *  so the background subagent can block until the user responds. */
export function pushApprovalRequired(
  jobId: string,
  stepIndex: number,
  toolName: string,
  input: unknown,
): Promise<boolean> {
  const s = getOrCreate(jobId);
  s.pendingApprovals.push({ stepIndex, toolName, input });

  // Update existing step to awaiting-approval.
  if (s.steps[stepIndex]) {
    s.steps[stepIndex].state = "awaiting-approval";
  }

  return new Promise<boolean>((resolve) => {
    const store = getStore();
    if (!store.approvalResolvers.has(jobId)) {
      store.approvalResolvers.set(jobId, new Map());
    }
    store.approvalResolvers.get(jobId)!.set(stepIndex, resolve);
    notify();
  });
}

/** Resolve a pending approval from the UI. Returns true if found. */
export function resolveApproval(
  jobId: string,
  stepIndex: number,
  approved: boolean,
): boolean {
  const store = getStore();
  const resolvers = store.approvalResolvers.get(jobId);
  if (!resolvers) return false;
  const fn = resolvers.get(stepIndex);
  if (!fn) return false;
  fn(approved);
  resolvers.delete(stepIndex);
  // Update the step state in the progress store.
  const s = store.state.get(jobId);
  if (s) {
    const step = s.steps[stepIndex];
    if (step) {
      if (approved) {
        step.state = "pending"; // Will transition to done/error when tool executes
      } else {
        step.state = "denied";
      }
    }
    s.pendingApprovals = s.pendingApprovals.filter(
      (p) => p.stepIndex !== stepIndex,
    );
  }
  notify();
  return true;
}

export function finishSubagent(jobId: string, error?: string) {
  const store = getStore();
  const s = getOrCreate(jobId);
  s.status = error ? "error" : "done";
  if (error) s.error = error;
  // Auto-deny any remaining pending approvals.
  const resolvers = store.approvalResolvers.get(jobId);
  if (resolvers) {
    for (const [, fn] of resolvers) fn(false);
    store.approvalResolvers.delete(jobId);
  }
  notify();
}

/** Seed/update progress for pipeline steps that are not local streamText jobs (e.g. ACP). */
export function setSubagentSummary(
  jobId: string,
  opts: { text?: string; status?: "running" | "done" | "error"; error?: string },
): void {
  const s = getOrCreate(jobId);
  if (opts.text !== undefined) s.text = opts.text;
  if (opts.status) s.status = opts.status;
  if (opts.error !== undefined) s.error = opts.error;
  notify();
}

export function getSubagentState(jobId: string): SubagentStreamState | null {
  return getStore().state.get(jobId) ?? null;
}

export function subscribeSubagentProgress(fn: () => void): () => void {
  const { bus } = getStore();
  bus.addEventListener(EVT, fn);
  return () => bus.removeEventListener(EVT, fn);
}

export function cleanupSubagent(jobId: string) {
  const store = getStore();
  store.state.delete(jobId);
  store.approvalResolvers.delete(jobId);
  notify();
}
