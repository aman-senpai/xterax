import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildProfileTools } from "@/modules/engineering-profile/tools";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

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
 *  - Engineering Profile tools (`record_preference_signal`,
 *    `record_preference_signal`, `record_rejection_signal`,
 *    `refine_profile`, `set_refinement_config`) auto-execute because the
 *    continuous-learning agent owns the profile and updates it
 *    autonomously — the same way the chat agent's own memory of the user
 *    evolves.
 *  - `rollback_profile` requires explicit user approval because it is a
 *    destructive action against history.
 *  - Engineering Profile read tools (`get_profile`, `explain_preference`,
 *    `show_profile_history`, `show_signals`, `list_project_profiles`)
 *    auto-execute.
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
    ...buildProfileTools(ctx),
  } as const;
}

export type ChatTools = ReturnType<typeof buildTools>;
