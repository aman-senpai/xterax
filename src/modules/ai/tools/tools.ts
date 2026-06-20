import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildPlanModeTools } from "./plan";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";
import { buildMcpTools } from "@/modules/mcp/tools";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy:
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - Mutating tools (`write_file`, `edit`, `multi_edit`, `create_directory`,
 *    `run_command`) require explicit user approval — the AI SDK pauses on
 *    tool-call and surfaces a `tool-approval-request` part that the UI
 *    renders as a confirmation card.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 *
 * Note: Continuous learning / engineering profile (signal collection,
 * refinement, .xterax/profile.md maintenance) is fully separated. It runs in
 * the background via passive observation and the autonomous learning agent.
 * The main chat agent is unaware and receives taste only via passive context
 * injection (similar to XTERAX.md).
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildPlanModeTools(),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
    ...buildMcpTools(),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
