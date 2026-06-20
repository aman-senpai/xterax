import { tool } from "ai";
import { z } from "zod";
import { usePlanStore } from "../store/planStore";

export function buildPlanModeTools() {
  return {
    enter_plan_mode: tool({
      description:
        "Enter plan mode for non-trivial tasks. Switches to read-only investigation: mutations (edit, write_file, create_directory) will be queued for review instead of applied immediately, and bash commands are disabled. Use this BEFORE investigating complex multi-step tasks. After the user approves your queued edits, call exit_plan_mode and execute the changes. Auto-executes (no approval needed).",
      inputSchema: z.object({}),
      execute: async () => {
        const store = usePlanStore.getState();
        if (store.active) {
          return {
            plan_mode: true,
            message:
              "Plan mode is already active. Continue with read-only investigation.",
          };
        }
        store.enable("agent");
        return {
          plan_mode: true,
          message:
            "Plan mode active. Use read-only tools to investigate. Mutations will be queued for review. bash commands are disabled.",
        };
      },
    }),
    exit_plan_mode: tool({
      description:
        "Exit plan mode and resume normal tool execution. Call this after the user has approved your queued edits (via the Apply button in the UI). Auto-executes (no approval needed).",
      inputSchema: z.object({}),
      execute: async () => {
        const store = usePlanStore.getState();
        const queuedCount = store.queue.length;
        store.disable();
        return {
          plan_mode: false,
          queued_edits_remaining: queuedCount,
          message:
            queuedCount > 0
              ? `Plan mode exited. ${queuedCount} queued edit(s) remain — they were NOT auto-applied. The user may apply or discard them from the UI.`
              : "Plan mode exited. Normal execution resumed.",
        };
      },
    }),
  } as const;
}
