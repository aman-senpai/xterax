import { LazyStore } from "@tauri-apps/plugin-store";
import { native } from "@/modules/ai/lib/native";
import {
  DEFAULT_REFINEMENT_CONFIG,
  type Preference,
  type Profile,
  type ProfileSnapshot,
  type RefinementConfig,
  type Signal,
  type SignalSource,
} from "./types";

const STORE_PATH = "terax-engineering-profile.json";

const KEY_USER_PROFILE = "user.profile";
const KEY_PROJECT_PROFILE_PREFIX = "project.profile:";
const KEY_USER_SNAPSHOTS = "user.snapshots";
const KEY_PROJECT_SNAPSHOTS_PREFIX = "project.snapshots:";
const KEY_USER_SIGNALS = "user.signals";
const KEY_PROJECT_SIGNALS_PREFIX = "project.signals:";
const KEY_CONFIG = "config";
const KEY_PROJECT_PROFILE_BY_ROOT = "project.profilesByRoot";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 400 });

let configCache: RefinementConfig | null = null;
let configLoadPromise: Promise<RefinementConfig | null> | null = null;

export function getCachedConfig(): RefinementConfig {
  if (configCache) return configCache;
  return DEFAULT_REFINEMENT_CONFIG;
}

export function setCachedConfig(cfg: RefinementConfig): void {
  configCache = cfg;
}

const MAX_SIGNALS_PER_SCOPE = 5000;
const MAX_SNAPSHOTS_PER_SCOPE = 50;

let fsMirrorDisabled = false;
let fsMirrorWarned = false;
let fsMirrorEnabled = false;

async function ensureFsMirrorRoot(workspaceRoot: string): Promise<string> {
  return `${workspaceRoot.replace(/\/$/, "")}/.terx/engineering-profile`;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newSignalId(): string {
  return newId("sig");
}

export function newPreferenceId(): string {
  return newId("pref");
}

export function newSnapshotId(): string {
  return newId("snap");
}

function projectKey(root: string): string {
  return root.replace(/[\\/]/g, "_").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function projectProfileKey(root: string): string {
  return `${KEY_PROJECT_PROFILE_PREFIX}${projectKey(root)}`;
}

function projectSignalsKey(root: string): string {
  return `${KEY_PROJECT_SIGNALS_PREFIX}${projectKey(root)}`;
}

function projectSnapshotsKey(root: string): string {
  return `${KEY_PROJECT_SNAPSHOTS_PREFIX}${projectKey(root)}`;
}

type Stored = {
  getProfile: (scope: "user" | "project", projectRoot: string | null) => Promise<Profile | null>;
  saveProfile: (profile: Profile) => Promise<void>;
  appendSignal: (signal: Signal) => Promise<void>;
  loadSignals: (scope: "user" | "project", projectRoot: string | null) => Promise<Signal[]>;
  appendSnapshot: (snapshot: ProfileSnapshot) => Promise<void>;
  loadSnapshots: (
    scope: "user" | "project",
    projectRoot: string | null,
  ) => Promise<ProfileSnapshot[]>;
  replaceSnapshots: (
    scope: "user" | "project",
    projectRoot: string | null,
    snapshots: ProfileSnapshot[],
  ) => Promise<void>;
  getConfig: () => Promise<unknown>;
  saveConfig: (config: unknown) => Promise<void>;
  listProjectProfiles: () => Promise<{ root: string; profile: Profile }[]>;
  writeHumanView: (profile: Profile) => Promise<void>;
};

export const storage: Stored = {
  async getProfile(scope, projectRoot) {
    if (scope === "user") {
      return (await store.get<Profile>(KEY_USER_PROFILE)) ?? null;
    }
    if (!projectRoot) return null;
    return (
      (await store.get<Profile>(projectProfileKey(projectRoot))) ?? null
    );
  },

  async saveProfile(profile) {
    if (profile.scope === "user") {
      await store.set(KEY_USER_PROFILE, profile);
    } else if (profile.projectRoot) {
      await store.set(projectProfileKey(profile.projectRoot), profile);
      const map =
        (await store.get<Record<string, Profile>>(KEY_PROJECT_PROFILE_BY_ROOT)) ??
        {};
      map[profile.projectRoot] = profile;
      await store.set(KEY_PROJECT_PROFILE_BY_ROOT, map);
    }
    if (!fsMirrorDisabled) {
      try {
        await writeHumanViewImpl(profile);
      } catch (err) {
        if (!fsMirrorWarned) {
          fsMirrorWarned = true;
          console.warn(
            "[engineering-profile] human-view write disabled:",
            err,
          );
        }
        fsMirrorDisabled = true;
      }
    }
  },

  async appendSignal(signal) {
    const key =
      signal.scope === "user"
        ? KEY_USER_SIGNALS
        : signal.projectRoot
          ? projectSignalsKey(signal.projectRoot)
          : KEY_USER_SIGNALS;
    const list = (await store.get<Signal[]>(key)) ?? [];
    list.push(signal);
    if (list.length > MAX_SIGNALS_PER_SCOPE) {
      list.splice(0, list.length - MAX_SIGNALS_PER_SCOPE);
    }
    await store.set(key, list);
  },

  async loadSignals(scope, projectRoot) {
    if (scope === "user") {
      return (await store.get<Signal[]>(KEY_USER_SIGNALS)) ?? [];
    }
    if (!projectRoot) return [];
    return (
      (await store.get<Signal[]>(projectSignalsKey(projectRoot))) ?? []
    );
  },

  async appendSnapshot(snapshot) {
    const key =
      snapshot.scope === "user"
        ? KEY_USER_SNAPSHOTS
        : snapshot.projectRoot
          ? projectSnapshotsKey(snapshot.projectRoot)
          : KEY_USER_SNAPSHOTS;
    const list = (await store.get<ProfileSnapshot[]>(key)) ?? [];
    list.push(snapshot);
    if (list.length > MAX_SNAPSHOTS_PER_SCOPE) {
      list.splice(0, list.length - MAX_SNAPSHOTS_PER_SCOPE);
    }
    await store.set(key, list);
  },

  async loadSnapshots(scope, projectRoot) {
    if (scope === "user") {
      return (await store.get<ProfileSnapshot[]>(KEY_USER_SNAPSHOTS)) ?? [];
    }
    if (!projectRoot) return [];
    return (
      (await store.get<ProfileSnapshot[]>(projectSnapshotsKey(projectRoot))) ??
      []
    );
  },

  async replaceSnapshots(scope, projectRoot, snapshots) {
    const key =
      scope === "user"
        ? KEY_USER_SNAPSHOTS
        : projectRoot
          ? projectSnapshotsKey(projectRoot)
          : KEY_USER_SNAPSHOTS;
    await store.set(key, snapshots);
  },

  async getConfig() {
    if (configCache) return configCache;
    if (configLoadPromise) return configLoadPromise;
    configLoadPromise = (async () => {
      const stored = (await store.get<Partial<RefinementConfig>>(KEY_CONFIG)) ?? null;
      const cfg = stored
        ? { ...DEFAULT_REFINEMENT_CONFIG, ...stored }
        : { ...DEFAULT_REFINEMENT_CONFIG };
      configCache = cfg;
      configLoadPromise = null;
      return cfg;
    })();
    return configLoadPromise;
  },

  async saveConfig(config) {
    const cfg = { ...DEFAULT_REFINEMENT_CONFIG, ...(config as Partial<RefinementConfig>) };
    configCache = cfg;
    await store.set(KEY_CONFIG, cfg);
  },

  async listProjectProfiles() {
    const map =
      (await store.get<Record<string, Profile>>(KEY_PROJECT_PROFILE_BY_ROOT)) ??
      {};
    return Object.entries(map).map(([root, profile]) => ({ root, profile }));
  },

  async writeHumanView(profile) {
    await writeHumanViewImpl(profile);
  },
};

async function writeHumanViewImpl(profile: Profile): Promise<void> {
  if (profile.scope === "user") return;
  const workspaceRoot = profile.projectRoot;
  if (!workspaceRoot) return;
  if (!fsMirrorEnabled) {
    try {
      await ensureDir(workspaceRoot);
      fsMirrorEnabled = true;
    } catch {
      fsMirrorDisabled = true;
      return;
    }
  }
  const root = await ensureFsMirrorRoot(workspaceRoot);
  await ensureDir(root);
  await writeFile(`${root}/profile.json`, JSON.stringify(profile, null, 2));
  await writeFile(`${root}/profile.md`, renderProfileMarkdown(profile));
  for (const dp of Object.values(profile.domains)) {
    if (dp.split && dp.splitPath) {
      const absDir = `${workspaceRoot.replace(/\/$/, "")}/${dp.splitPath.replace(/\/profile\.md$/, "")}`;
      await ensureDir(absDir);
      await writeFile(
        `${workspaceRoot.replace(/\/$/, "")}/${dp.splitPath}`,
        renderDomainProfileMarkdown(dp),
      );
    }
  }
  const snapshots = await storage.loadSnapshots(
    profile.scope,
    profile.projectRoot,
  );
  if (snapshots.length > 0) {
    await ensureDir(`${root}/history`);
    for (const snap of snapshots.slice(-20)) {
      await writeFile(
        `${root}/history/${snap.id}.json`,
        JSON.stringify(snap, null, 2),
      );
    }
  }
}

async function ensureDir(path: string): Promise<void> {
  try {
    await native.createDir(path);
  } catch {
    /* already exists */
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  await native.writeFile(path, content);
}

function renderProfileMarkdown(profile: Profile): string {
  const lines: string[] = [];
  lines.push("# Engineering Profile (Continuously Learned by Terax)");
  lines.push("");
  lines.push("Auto-generated by the autonomous continuous-learning agent. Each preference carries a confidence score in [0, 1] that increases with repeated evidence and decays with disuse. Edit `.terax/profile.json` for the canonical state.");
  lines.push("");
  const domainList = Object.values(profile.domains)
    .filter((d) => !d.split)
    .sort((a, b) => b.preferences.length - a.preferences.length);
  for (const dp of domainList) {
    if (dp.preferences.length === 0) continue;
    lines.push(`# ${dp.category}`);
    lines.push("");
    for (const p of dp.preferences) {
      lines.push(renderPreferenceLine(p));
    }
    lines.push("");
  }
  const splitRefs = Object.values(profile.domains)
    .filter((d) => d.split && d.splitPath)
    .sort((a, b) => b.preferences.length - a.preferences.length);
  for (const dp of splitRefs) {
    lines.push(`# ${dp.category}`);
    lines.push("");
    lines.push(`See ${dp.splitPath} (${dp.preferences.length} preferences)`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderDomainProfileMarkdown(dp: Profile["domains"][string]): string {
  const lines: string[] = [];
  lines.push(`# ${dp.category} (Continuously Learned by Terax)`);
  lines.push("");
  lines.push("Auto-generated by the autonomous continuous-learning agent.");
  lines.push("");
  if (dp.preferences.length === 0) {
    lines.push("_No preferences recorded yet._");
    return lines.join("\n");
  }
  for (const p of dp.preferences) {
    lines.push(renderPreferenceLine(p));
  }
  return lines.join("\n");
}

function renderPreferenceLine(p: Preference): string {
  const prefix = p.pinned ? "Pinned: " : "";
  const marker = p.evidenceCount === 0 ? " (rejected)" : "";
  const seenSuffix = p.evidenceCount > 1 ? ` (seen ${p.evidenceCount}x)` : "";
  const lastObserved = formatLastObserved(p.lastObservedAt);
  const tail = `Confidence: ${p.confidence.toFixed(2)}${seenSuffix}${lastObserved ? `, last ${lastObserved}` : ""}${marker}`;
  return `- ${prefix}${p.preference}. ${tail}`;
}

function formatLastObserved(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const iso = d.toISOString().slice(0, 10);
  if (iso === "1970-01-01") return "";
  return iso;
}

export function makeBlankProfile(
  scope: "user" | "project",
  projectRoot: string | null,
  generatedAt: number = Date.now(),
): Profile {
  return {
    id: newId("profile"),
    scope,
    projectRoot,
    generatedAt,
    summary: "",
    preferences: [],
    domains: {},
  };
}

export type { Signal, SignalSource };
