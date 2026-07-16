import { tool } from "ai";
import { z } from "zod";
import {
  MAX_SUBAGENT_TASKS,
  spawnSubagent,
  waitForSubagents,
} from "../agents/runSubagent";
import { registerBatch } from "../agents/subagentProgress";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { MODELS, providerNeedsKey } from "../config";
import type { ToolContext } from "./context";

export function buildSubagentTools(ctx: ToolContext) {
  return {
    run_subagent: tool({
      description: `Spawn one or more background subagents that work in PARALLEL. Each subagent is a full agent with read/write/run access — they can read files, write code, run commands, everything.

Provide an array of tasks — each with a short 'description' label and a self-contained 'prompt' that includes WHAT to do and WHERE to do it. The tool blocks until ALL subagents complete, then returns all results at once. No polling, no follow-up calls.

IMPORTANT: Spawn ALL subagents in ONE call so they run concurrently. Include full instructions in each prompt — subagents have no memory of your conversation. Max ${MAX_SUBAGENT_TASKS} tasks per call.

Asks for user approval when spawning more than one subagent.`,
      inputSchema: z.object({
        tasks: z
          .array(
            z.object({
              description: z
                .string()
                .describe(
                  "Short label shown while the subagent runs (e.g. 'Research auth patterns')",
                ),
              prompt: z
                .string()
                .describe(
                  "Self-contained instruction with all context. Include file paths, what to do, and where to put output.",
                ),
              agentType: z
                .enum([
                  "coder",
                  "implement",
                  "architect",
                  "reviewer",
                  "review-agent",
                  "security",
                  "designer",
                  "design",
                  "verification",
                ])
                .optional()
                .describe(
                  "Specialist persona to assign. Omit for a general-purpose subagent. Handles: architect, coder/implement, reviewer/review-agent, security, designer/design, verification.",
                ),
            }),
          )
          .max(MAX_SUBAGENT_TASKS)
          .describe(
            `One or more tasks to run in parallel (max ${MAX_SUBAGENT_TASKS}).`,
          ),
      }),
      // Multi-task fan-out is high impact — require approval when N > 1.
      // Single-task research stays auto for low friction; the execute path
      // still respects session permissionMode via the parent agent gate.
      needsApproval: async ({ tasks }) => (tasks?.length ?? 0) > 1,
      execute: async ({ tasks }) => {
        const { apiKeys } = useChatStore.getState();

        if (!tasks || tasks.length === 0) {
          return { results: [] };
        }

        if (tasks.length > MAX_SUBAGENT_TASKS) {
          return {
            error: `Too many subagent tasks (${tasks.length}). Max is ${MAX_SUBAGENT_TASKS}. Split into multiple run_subagent calls.`,
            denied: true,
          };
        }

        const prefs = usePreferencesStore.getState();
        const provider = prefs.subagentProvider;
        const modelId = prefs.subagentModelId;
        const thinkingLevel = prefs.subagentThinkingLevel;

        const isLocal = !providerNeedsKey(provider);
        const fallback = MODELS[0];
        const currentModel = isLocal
          ? (MODELS.find((m) => m.provider === provider) ?? fallback)
          : (MODELS.find((m) => m.provider === provider && m.id === modelId) ??
            MODELS.find((m) => m.id === modelId) ??
            fallback);

        const resolvedModelId = currentModel.id;

        const spawned: Array<{ jobId: string; desc: string }> = [];
        const jobIds = tasks.map((t) => {
          const jobId = spawnSubagent({
            prompt: t.prompt,
            description: t.description,
            agentType: t.agentType ?? null,
            keys: apiKeys,
            modelId: resolvedModelId,
            thinkingLevel,
            toolContext: ctx,
          });
          spawned.push({
            jobId,
            desc: t.description || `Task ${spawned.length + 1}`,
          });
          return jobId;
        });

        registerBatch(spawned);

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
