export type SubagentStreamState = {
  status: "running" | "done" | "error";
  text: string;
  steps: Array<{
    toolName: string;
    input: unknown;
    output?: unknown;
    state: "pending" | "done" | "error" | "awaiting-approval" | "denied";
    errorText?: string;
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

type Listener = () => void;

const state = new Map<string, SubagentStreamState>();
const listeners = new Set<Listener>();

/** Map from jobId → Map<stepIndex, resolve(approved: boolean)> */
const approvalResolvers = new Map<string, Map<number, (approved: boolean) => void>>();

/** Map from task index → jobId for the current batch. */
let currentBatch: Array<{ jobId: string; desc: string }> = [];

export function registerBatch(tasks: Array<{ jobId: string; desc: string }>) {
  currentBatch = tasks;
}

export function getCurrentBatch(): Array<{ jobId: string; desc: string }> {
  return currentBatch;
}

function notify() {
  for (const fn of listeners) fn();
}

function getOrCreate(jobId: string): SubagentStreamState {
  let s = state.get(jobId);
  if (!s) {
    s = {
      status: "running",
      text: "",
      steps: [],
      reasoning: "",
      startedAt: Date.now(),
      pendingApprovals: [],
    };
    state.set(jobId, s);
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
) {
  const s = getOrCreate(jobId);
  while (s.steps.length <= stepIndex) {
    s.steps.push({ toolName, input, state: "pending" });
  }
  s.steps[stepIndex] = { toolName, input, state: "pending" };
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
  _toolCallId: string,
  output: unknown,
  errorText?: string,
) {
  const s = getOrCreate(jobId);
  const step = s.steps.find(
    (st) =>
      st.state === "pending" ||
      st.state === "awaiting-approval",
  );
  if (step) {
    step.output = output;
    step.state = errorText ? "error" : "done";
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
    if (!approvalResolvers.has(jobId)) {
      approvalResolvers.set(jobId, new Map());
    }
    approvalResolvers.get(jobId)!.set(stepIndex, resolve);
    notify();
  });
}

/** Resolve a pending approval from the UI. Returns true if found. */
export function resolveApproval(
  jobId: string,
  stepIndex: number,
  approved: boolean,
): boolean {
  const resolvers = approvalResolvers.get(jobId);
  if (!resolvers) return false;
  const fn = resolvers.get(stepIndex);
  if (!fn) return false;
  fn(approved);
  resolvers.delete(stepIndex);
  // Update the step state in the progress store.
  const s = state.get(jobId);
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
  const s = getOrCreate(jobId);
  s.status = error ? "error" : "done";
  if (error) s.error = error;
  // Auto-deny any remaining pending approvals.
  const resolvers = approvalResolvers.get(jobId);
  if (resolvers) {
    for (const [, fn] of resolvers) fn(false);
    approvalResolvers.delete(jobId);
  }
  notify();
}

export function getSubagentState(jobId: string): SubagentStreamState | null {
  return state.get(jobId) ?? null;
}

export function subscribeSubagentProgress(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function cleanupSubagent(jobId: string) {
  state.delete(jobId);
  approvalResolvers.delete(jobId);
  notify();
}
