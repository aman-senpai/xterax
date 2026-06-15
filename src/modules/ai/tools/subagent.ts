import { tool } from "ai";
import { z } from "zod";
import { spawnSubagent, waitForSubagents } from "../agents/runSubagent";
import { registerBatch } from "../agents/subagentProgress";
import { useChatStore } from "../store/chatStore";
import type { ToolContext } from "./context";

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn one or more background subagents that work in PARALLEL. Each subagent is a full agent with read/write/run access — they can read files, write code, run commands, everything.

Provide an array of tasks — each with a short 'description' label and a self-contained 'prompt' that includes WHAT to do and WHERE to do it. The tool blocks until ALL subagents complete, then returns all results at once. No polling, no follow-up calls.

IMPORTANT: Spawn ALL subagents in ONE call so they run concurrently. Include full instructions in each prompt — subagents have no memory of your conversation.

Auto-executes (no approval).`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              description: z
                .string()
                .describe("Short label shown while the subagent runs (e.g. 'Research auth patterns')"),
              prompt: z
                .string()
                .describe("Self-contained instruction with all context. Include file paths, what to do, and where to put output."),
            }),
          )
          .describe("One or more tasks to run in parallel."),
      }),
      execute: async ({ tasks }) => {
        const { apiKeys, selectedModelId } =
          useChatStore.getState();

        if (tasks.length === 0) {
          return { results: [] };
        }

        // Spawn all subagents in parallel — each returns immediately with a jobId.
        const spawned: Array<{ jobId: string; desc: string }> = [];
        const jobIds = tasks.map((t) => {
          const jobId = spawnSubagent({
            prompt: t.prompt,
            description: t.description,
            keys: apiKeys,
            modelId: selectedModelId,
            toolContext: ctx,
          });
          spawned.push({ jobId, desc: t.description || `Task ${spawned.length + 1}` });
          return jobId;
        });

        // Register batch so the UI can subscribe to per-task streaming progress.
        registerBatch(spawned);

        // Block until all complete, then return results.
        const results = await waitForSubagents(jobIds);

        return {
          results: results.map((r) => ({
            description: r.description,
            status: r.status,
            summary: r.summary,
            stepCount: r.stepCount,
            durationMs: r.durationMs,
            error: r.error,
          })),
          allDone: true,
        };
      },
    }),
  } as const;
}
