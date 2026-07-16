import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  BUILTIN_MODES,
  loadModes,
  MODE_DEFAULT_ID,
  MODE_PLAN_ID,
  type Mode,
  newModeId,
  saveActiveModeId,
  saveCustomModes,
} from "../lib/modes";
import { usePlanStore } from "./planStore";

const CHANGED_EVENT = "xterax://ai-modes-changed";

type ModesState = {
  hydrated: boolean;
  customModes: Mode[];
  activeId: string;
  all: () => Mode[];
  hydrate: () => Promise<void>;
  setActiveId: (id: string) => void;
  upsert: (mode: Mode) => void;
  remove: (id: string) => void;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

function syncPlanStore(mode: Mode | undefined): void {
  const plan = usePlanStore.getState();
  if (mode?.enablePlanMode) {
    if (!plan.active) plan.enable("user");
  } else if (plan.active && plan.source === "user") {
    // Only clear plan mode when we left a plan-enabled mode via the mode UI.
    // Agent-entered plan mode keeps its own lifecycle.
    plan.disable();
  }
}

export const useModesStore = create<ModesState>((set, get) => ({
  hydrated: false,
  customModes: [],
  activeId: MODE_DEFAULT_ID,
  all: (() => {
    let cached: Mode[] | null = null;
    let lastCustom: Mode[] | undefined;
    return () => {
      const { customModes } = get();
      if (cached && lastCustom === customModes) return cached;
      lastCustom = customModes;
      cached = [...BUILTIN_MODES, ...customModes];
      return cached;
    };
  })(),
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const loaded = await loadModes();
    set({
      customModes: loaded.custom,
      activeId: loaded.activeId,
      hydrated: true,
    });
    const mode = get()
      .all()
      .find((m) => m.id === loaded.activeId);
    if (mode?.enablePlanMode) {
      usePlanStore.getState().enable("user");
    }

    void listen(CHANGED_EVENT, async () => {
      const fresh = await loadModes();
      set({ customModes: fresh.custom, activeId: fresh.activeId });
    });
  },
  setActiveId: (id) => {
    set({ activeId: id });
    void saveActiveModeId(id).then(broadcast);
    const mode = get()
      .all()
      .find((m) => m.id === id);
    syncPlanStore(mode);
  },
  upsert: (mode) => {
    if (mode.builtIn) return;
    const list = get().customModes;
    const idx = list.findIndex((m) => m.id === mode.id);
    const next =
      idx === -1
        ? [...list, mode]
        : list.map((m) => (m.id === mode.id ? mode : m));
    set({ customModes: next });
    void saveCustomModes(next).then(broadcast);
  },
  remove: (id) => {
    const list = get().customModes.filter((m) => m.id !== id);
    set({ customModes: list });
    if (get().activeId === id) {
      set({ activeId: MODE_DEFAULT_ID });
      void saveActiveModeId(MODE_DEFAULT_ID);
      syncPlanStore(BUILTIN_MODES[0]);
    }
    void saveCustomModes(list).then(broadcast);
  },
}));

/** Active mode for transport / tool filtering. */
export function getActiveMode(): Mode {
  const { activeId, all } = useModesStore.getState();
  return all().find((m) => m.id === activeId) ?? BUILTIN_MODES[0];
}

/** Keep mode UI in sync when /plan toggles planStore. */
export function syncModeFromPlanStore(active: boolean): void {
  const store = useModesStore.getState();
  if (active && store.activeId !== MODE_PLAN_ID) {
    store.setActiveId(MODE_PLAN_ID);
  } else if (!active && store.activeId === MODE_PLAN_ID) {
    store.setActiveId(MODE_DEFAULT_ID);
  }
}

export { MODE_DEFAULT_ID, MODE_PLAN_ID, newModeId };
