/**
 * Resolve a pipeline AST against the agent registry (local + ACP).
 * Expands agent workflows into leaf steps.
 */

import {
  type AcpAgentRef,
  type Agent,
  type PipelineStep,
  buildAcpHandleMap,
  expandWorkflow,
  findAcpByHandle,
  findAgentByHandle,
  resolveHandleToken,
} from "./agents";
import {
  type BreakCond,
  type PipelineAstNode,
  type PipelineProgram,
  estimateMaxAgentRuns,
} from "./pipelineDsl";

export type ResolvedAgentRef = PipelineStep;

export type CompiledNode =
  | { type: "agent"; step: ResolvedAgentRef; handle: string; name: string }
  | {
      type: "loop";
      max: number;
      breakWhen: BreakCond | null;
      body: CompiledNode[];
      /** Stable id for UI grouping */
      loopId: string;
    };

export type CompiledProgram = {
  nodes: CompiledNode[];
  body: string;
  /** Upper bound on agent runs if all loops max out. */
  maxRuns: number;
};

export function compilePipelineProgram(
  program: PipelineProgram,
  agents: readonly Agent[],
  acpAgents: readonly AcpAgentRef[] = [],
): { program: CompiledProgram; error?: undefined } | { program?: undefined; error: string } {
  const acpByHandle = buildAcpHandleMap(acpAgents, agents);
  let loopSeq = 0;

  function resolveHandle(
    token: string,
  ): { steps: ResolvedAgentRef[]; error?: string } {
    const local = findAgentByHandle(agents, token);
    if (local) {
      const expanded = expandWorkflow(agents, local, { acpByHandle });
      if (expanded.error) return { steps: [], error: expanded.error };
      return { steps: expanded.steps };
    }
    const acp = findAcpByHandle(acpByHandle, token);
    if (acp) {
      return {
        steps: [{ kind: "acp", handle: acp.handle, config: acp.config }],
      };
    }
    return {
      steps: [],
      error: `Unknown agent @${resolveHandleToken(token)}`,
    };
  }

  function compileNodes(
    nodes: PipelineAstNode[],
  ): { nodes: CompiledNode[]; error?: string } {
    const out: CompiledNode[] = [];
    for (const n of nodes) {
      if (n.type === "agent") {
        const r = resolveHandle(n.handle);
        if (r.error) return { nodes: [], error: r.error };
        for (const step of r.steps) {
          const handle =
            step.kind === "local" ? step.agent.handle : step.handle;
          const name = step.kind === "local" ? step.agent.name : step.config.name;
          out.push({ type: "agent", step, handle, name });
        }
        continue;
      }
      const body = compileNodes(n.body);
      if (body.error) return { nodes: [], error: body.error };
      if (body.nodes.length === 0) {
        return { nodes: [], error: "Empty loop body" };
      }
      loopSeq += 1;
      out.push({
        type: "loop",
        max: n.max,
        breakWhen: n.breakWhen,
        body: body.nodes,
        loopId: `L${loopSeq}`,
      });
    }
    return { nodes: out };
  }

  const compiled = compileNodes(program.nodes);
  if (compiled.error) return { error: compiled.error };

  const maxRuns = estimateMaxAgentRuns(program.nodes);
  if (maxRuns > 32) {
    return { error: `Pipeline too large (up to ${maxRuns} agent runs)` };
  }

  return {
    program: {
      nodes: compiled.nodes,
      body: program.body,
      maxRuns,
    },
  };
}

/** Flatten compiled program structure for static UI preview (loops nested). */
export type PipelineDisplayNode =
  | {
      kind: "agent";
      handle: string;
      name: string;
      backend: "local" | "acp";
    }
  | {
      kind: "loop";
      loopId: string;
      max: number;
      breakWhen: BreakCond | null;
      body: PipelineDisplayNode[];
    };

export function toDisplayNodes(nodes: CompiledNode[]): PipelineDisplayNode[] {
  return nodes.map((n) => {
    if (n.type === "agent") {
      return {
        kind: "agent" as const,
        handle: n.handle,
        name: n.name,
        backend: n.step.kind === "acp" ? ("acp" as const) : ("local" as const),
      };
    }
    return {
      kind: "loop" as const,
      loopId: n.loopId,
      max: n.max,
      breakWhen: n.breakWhen,
      body: toDisplayNodes(n.body),
    };
  });
}
