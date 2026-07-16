import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  BUILTIN_AGENTS,
  loadAgents,
  newAgentId,
  saveActiveAgentId,
  saveCustomAgents,
  type Agent,
} from "../lib/agents";
import type { AgentOverride } from "@/modules/settings/store";

const CHANGED_EVENT = "xterax://ai-agents-changed";
const PREFS_CHANGED_EVENT = "xterax://prefs-changed";
const PREFS_STORE_PATH = "xterax-settings.json";
const KEY_AGENT_OVERRIDES = "agentOverrides";

const prefsStore = new LazyStore(PREFS_STORE_PATH, { defaults: {}, autoSave: 200 });

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  activeId: string;
  /** Built-in agent overrides from preferences (instructions, tool/shell allowlists). */
  builtinOverrides: Record<string, AgentOverride>;
  /** Set built-in overrides (called from settings UI). */
  setBuiltinOverrides: (overrides: Record<string, AgentOverride>) => void;
  /** All agents, builtin first, with overrides applied to builtins. */
  all: () => Agent[];
  hydrate: () => Promise<void>;
  setActiveId: (id: string) => void;
  upsert: (agent: Agent) => void;
  remove: (id: string) => void;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

/** Apply overrides to a built-in agent, returning a new object. */
function applyOverride(agent: Agent, override?: AgentOverride): Agent {
  if (!override) return agent;
  return {
    ...agent,
    instructions:
      override.instructions !== undefined
        ? override.instructions
        : agent.instructions,
    toolAllowlist:
      override.toolAllowlist !== undefined
        ? override.toolAllowlist
        : agent.toolAllowlist,
    shellAllowlist:
      override.shellAllowlist !== undefined
        ? override.shellAllowlist
        : agent.shellAllowlist,
    modelId:
      override.modelId !== undefined ? override.modelId : agent.modelId,
    thinkingLevel:
      override.thinkingLevel !== undefined
        ? override.thinkingLevel
        : agent.thinkingLevel,
    workflow:
      override.workflow !== undefined ? override.workflow : agent.workflow,
  };
}

/** Load agent overrides from the shared preferences store. */
async function loadBuiltinOverrides(): Promise<Record<string, AgentOverride>> {
  try {
    const entries = await prefsStore.entries();
    const map = new Map<string, unknown>(entries);
    const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;

    // First, check the new agentOverrides key
    const stored =
      get<Record<string, AgentOverride>>(KEY_AGENT_OVERRIDES) ?? {};

    // Migration: if no agentOverrides exist for a builtin but old
    // promptOverrides have an agent:* key, migrate the instructions.
    const promptOverrides =
      get<Record<string, string>>("promptOverrides") ?? {};

    for (const a of BUILTIN_AGENTS) {
      if (!stored[a.id]) {
        const promptKey = `agent:${a.id.replace("builtin:", "")}`;
        if (promptOverrides[promptKey]) {
          stored[a.id] = { instructions: promptOverrides[promptKey] };
        }
      }
    }

    return stored;
  } catch {
    // Preferences store not yet available — use defaults
  }
  return {};
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  activeId: BUILTIN_AGENTS[0].id,
  builtinOverrides: {},
  setBuiltinOverrides: (overrides) => set({ builtinOverrides: overrides }),
  // Memoized so selectors like (s) => s.all() return a stable reference
  // when the underlying data hasn't changed — avoids useSyncExternalStore
  // infinite loops (new array/object refs on every call).
  all: (() => {
    let cached: Agent[] | null = null;
    let lastOverrides: Record<string, AgentOverride> | undefined;
    let lastCustom: Agent[] | undefined;
    return () => {
      const { builtinOverrides, customAgents } = get();
      if (
        cached &&
        lastOverrides === builtinOverrides &&
        lastCustom === customAgents
      ) {
        return cached;
      }
      lastOverrides = builtinOverrides;
      lastCustom = customAgents;
      const builtins = BUILTIN_AGENTS.map((a) =>
        applyOverride(a, builtinOverrides[a.id]),
      );
      cached = [...builtins, ...customAgents];
      return cached;
    };
  })(),
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const [agents, overrides] = await Promise.all([
      loadAgents(),
      loadBuiltinOverrides(),
    ]);
    // One-time migration: users on the old default (builtin:coder) get the
    // new unified default (builtin:xterax).
    let activeId = agents.activeId;
    if (activeId === "builtin:coder") {
      activeId = "builtin:xterax";
      void saveActiveAgentId(activeId);
    }
    set({
      customAgents: agents.custom,
      activeId,
      builtinOverrides: overrides,
      hydrated: true,
    });

    void listen(CHANGED_EVENT, async () => {
      const fresh = await loadAgents();
      set({ customAgents: fresh.custom, activeId: fresh.activeId });
    });

    // Listen for agent override changes from the settings window
    void listen<{ key: string; value: unknown }>(
      PREFS_CHANGED_EVENT,
      (e) => {
        if (e.payload.key === KEY_AGENT_OVERRIDES) {
          const overrides =
            typeof e.payload.value === "object" && e.payload.value !== null
              ? (e.payload.value as Record<string, AgentOverride>)
              : {};
          set({ builtinOverrides: overrides });
        }
      },
    );
  },
  setActiveId: (id) => {
    set({ activeId: id });
    void saveActiveAgentId(id).then(broadcast);
  },
  upsert: (agent) => {
    if (agent.builtIn) return;
    const list = get().customAgents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next =
      idx === -1
        ? [...list, agent]
        : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customAgents: next });
    void saveCustomAgents(next).then(broadcast);
  },
  remove: (id) => {
    const list = get().customAgents.filter((a) => a.id !== id);
    set({ customAgents: list });
    let active = get().activeId;
    if (active === id) {
      active = BUILTIN_AGENTS[0].id;
      set({ activeId: active });
      void saveActiveAgentId(active);
    }
    void saveCustomAgents(list).then(broadcast);
  },
}));

export { newAgentId };
