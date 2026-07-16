import { LazyStore } from "@tauri-apps/plugin-store";
import type { PermissionMode } from "../store/chatStore";

/**
 * Session posture — orthogonal to invokable agents.
 * Modes overlay the default Xterax agent; they do not replace specialists.
 */
export type Mode = {
  id: string;
  name: string;
  description: string;
  /**
   * Extra system overlay (empty for default / plan).
   * Plan mode uses the planStore path + getPlanModePrompt() in the agent runner.
   */
  instructions: string;
  /** Tool groups to allow. null = all tools. */
  toolAllowlist: string[] | null;
  /** When true, enables planStore (queue mutations). */
  enablePlanMode: boolean;
  /**
   * Optional session permission override while mode is active.
   * null = leave the user's permission picker alone.
   */
  permissionMode: PermissionMode | null;
  builtIn: boolean;
};

export const MODE_DEFAULT_ID = "builtin:default";
export const MODE_PLAN_ID = "builtin:plan";
export const MODE_REVIEW_ID = "builtin:review";

const REVIEW_INSTRUCTIONS = `You are in Review mode.
- Do not mutate files or run write tools. Prefer read_file, grep, glob, list_directory, get_terminal_output.
- Focus on correctness, edge cases, security, performance, and architectural fit.
- Output findings as \`[MUST/SHOULD/NIT] file:line — issue → fix\`. If nothing real, say "Looks good."
- Verify each finding against the actual code before reporting it.`;

export const BUILTIN_MODES: readonly Mode[] = [
  {
    id: MODE_DEFAULT_ID,
    name: "Default",
    description: "Full agent. Plans when needed, executes freely.",
    instructions: "",
    toolAllowlist: null,
    enablePlanMode: false,
    permissionMode: null,
    builtIn: true,
  },
  {
    id: MODE_PLAN_ID,
    name: "Plan",
    description: "Read-only investigation; mutations queued for review.",
    instructions: "",
    toolAllowlist: null,
    enablePlanMode: true,
    permissionMode: null,
    builtIn: true,
  },
  {
    id: MODE_REVIEW_ID,
    name: "Review",
    description: "Read-only review posture. No writes or shell mutations.",
    instructions: REVIEW_INSTRUCTIONS,
    toolAllowlist: ["fs", "search", "todo", "terminal"],
    enablePlanMode: false,
    permissionMode: "read-only",
    builtIn: true,
  },
];

const STORE_PATH = "xterax-modes.json";
const KEY_CUSTOM = "customModes";
const KEY_ACTIVE = "activeModeId";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedModes = {
  custom: Mode[];
  activeId: string;
};

function normalizeMode(raw: Partial<Mode> & { [k: string]: unknown }): Mode {
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : newModeId(),
    name: typeof raw.name === "string" && raw.name ? raw.name : "Unnamed",
    description: typeof raw.description === "string" ? raw.description : "",
    instructions: typeof raw.instructions === "string" ? raw.instructions : "",
    toolAllowlist:
      raw.toolAllowlist === undefined
        ? null
        : (raw.toolAllowlist as string[] | null),
    enablePlanMode: raw.enablePlanMode === true,
    permissionMode:
      raw.permissionMode === "default" ||
      raw.permissionMode === "auto-approve" ||
      raw.permissionMode === "read-only"
        ? raw.permissionMode
        : null,
    builtIn: raw.builtIn === true,
  };
}

export async function loadModes(): Promise<LoadedModes> {
  const entries = await store.entries();
  let custom: Mode[] | undefined;
  let activeId: string | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) {
      const raw = v as Array<Partial<Mode> & { [k: string]: unknown }>;
      custom = raw.map(normalizeMode).filter((m) => !m.builtIn);
    } else if (k === KEY_ACTIVE) {
      activeId = v as string;
    }
  }
  return {
    custom: custom ?? [],
    activeId: activeId ?? MODE_DEFAULT_ID,
  };
}

export async function saveCustomModes(custom: Mode[]): Promise<void> {
  await store.set(KEY_CUSTOM, custom);
  await store.save();
}

export async function saveActiveModeId(id: string): Promise<void> {
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

export function newModeId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function findMode(
  modes: readonly Mode[],
  id: string | null | undefined,
): Mode {
  if (!id) return BUILTIN_MODES[0];
  return modes.find((m) => m.id === id) ?? BUILTIN_MODES[0];
}
