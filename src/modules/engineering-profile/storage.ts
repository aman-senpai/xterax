import { native } from "@/modules/ai/lib/native";
import { LazyStore } from "@tauri-apps/plugin-store";
import {
  DEFAULT_REFINEMENT_CONFIG,
  type Domain,
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

// To prevent feedback loops where our own writes to .terax/profile.md (and split profiles)
// trigger Rust fs watchers → listenFsChanged → handlePaths → notifyUserFileEdit → syncProfileFromDisk
// which then writes again. We note the time of our writes; notifyUserFileEdit for profile paths
// within a short window after a self-write will skip the sync.
let lastProfileSelfWrite = 0;

export function noteProfileSelfWrite(): void {
  lastProfileSelfWrite = Date.now();
}

export function getLastProfileSelfWrite(): number {
  return lastProfileSelfWrite;
}

async function ensureFsMirrorRoot(workspaceRoot: string): Promise<string> {
  return `${workspaceRoot.replace(/\/$/, "")}/.terax`;
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
  getProfile: (
    scope: "user" | "project",
    projectRoot: string | null,
  ) => Promise<Profile | null>;
  saveProfile: (profile: Profile) => Promise<void>;
  appendSignal: (signal: Signal) => Promise<void>;
  loadSignals: (
    scope: "user" | "project",
    projectRoot: string | null,
  ) => Promise<Signal[]>;
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
    return (await store.get<Profile>(projectProfileKey(projectRoot))) ?? null;
  },

  async saveProfile(profile) {
    if (profile.scope === "user") {
      await store.set(KEY_USER_PROFILE, profile);
    } else if (profile.projectRoot) {
      await store.set(projectProfileKey(profile.projectRoot), profile);
      const map =
        (await store.get<Record<string, Profile>>(
          KEY_PROJECT_PROFILE_BY_ROOT,
        )) ?? {};
      map[profile.projectRoot] = profile;
      await store.set(KEY_PROJECT_PROFILE_BY_ROOT, map);
    }
    if (!fsMirrorDisabled) {
      try {
        await writeHumanViewImpl(profile);
      } catch (err) {
        if (!fsMirrorWarned) {
          fsMirrorWarned = true;
          console.warn("[engineering-profile] human-view write failed:", err);
        }
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
    return (await store.get<Signal[]>(projectSignalsKey(projectRoot))) ?? [];
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
      const stored =
        (await store.get<Partial<RefinementConfig>>(KEY_CONFIG)) ?? null;
      const cfg = stored
        ? { ...DEFAULT_REFINEMENT_CONFIG, ...stored }
        : { ...DEFAULT_REFINEMENT_CONFIG };
      // Normalize legacy "heuristic" provider.
      if ((cfg as any).provider === "heuristic") {
        cfg.provider = DEFAULT_REFINEMENT_CONFIG.provider;
        cfg.modelId = DEFAULT_REFINEMENT_CONFIG.modelId;
      }
      configCache = cfg;
      configLoadPromise = null;
      return cfg;
    })();
    return configLoadPromise;
  },

  async saveConfig(config) {
    const cfg = {
      ...DEFAULT_REFINEMENT_CONFIG,
      ...(config as Partial<RefinementConfig>),
    };
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
  if (profile.scope === "user" || fsMirrorDisabled) return;
  const workspaceRoot = profile.projectRoot;
  if (!workspaceRoot) return;

  // Note self-write *before* any native writes so that the fs:changed events
  // we inevitably emit won't cause a re-entrant syncProfileFromDisk (which would
  // otherwise rewrite profile.md and keep the loop going).
  noteProfileSelfWrite();

  // Write the pure profile for this scope/root.
  // Do NOT merge global user preferences here — that was causing the same
  // learned taste to be copied into .terax/ of every project, polluting
  // per-project learning and defeating project-level isolation.
  // Merging (if desired for effective context) happens in getMergedProfile /
  // buildContextPackage at runtime.
  const diskProfile = profile;

  if (!fsMirrorEnabled) {
    try {
      await ensureDir(workspaceRoot);
      fsMirrorEnabled = true;
    } catch (err) {
      if (!fsMirrorWarned) {
        fsMirrorWarned = true;
        console.warn(
          "[engineering-profile] human-view write failed to ensureDir:",
          err,
        );
      }
      return;
    }
  }
  const root = await ensureFsMirrorRoot(workspaceRoot);
  await ensureDir(root);

  const nextRootMd = renderProfileMarkdown(diskProfile);

  // Skip root profile.md rewrite when content is unchanged. This keeps
  // the human-visible file quiet when no preferences actually changed.
  let shouldWriteRootMd = true;
  try {
    const onDisk = await native.readFile(`${root}/profile.md`);
    if (onDisk.kind === "text" && onDisk.content === nextRootMd) {
      shouldWriteRootMd = false;
    }
  } catch {
    // no file or error -> write
  }

  if (shouldWriteRootMd) {
    await writeFile(`${root}/profile.md`, nextRootMd);
  }

  // Domain split files are written when marked split (they are small and stable).
  for (const dp of Object.values(diskProfile.domains)) {
    if (dp.split && dp.splitPath) {
      const lastSlashIdx = dp.splitPath.lastIndexOf("/");
      const dirPart =
        lastSlashIdx > 0 ? dp.splitPath.substring(0, lastSlashIdx) : "";
      const absDir = `${workspaceRoot.replace(/\/$/, "")}/${dirPart}`;
      await ensureDir(absDir);
      await writeFile(
        `${workspaceRoot.replace(/\/$/, "")}/${dp.splitPath}`,
        renderDomainProfileMarkdown(dp),
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
  lines.push("# Profile");
  lines.push("");
  lines.push(
    "This is the project's living profile — the continuously self-improving memory of choices, structures, patterns, tooling preferences, and micro-decisions.",
  );
  lines.push(
    "It is updated autonomously from signals (explicit statements, accepts, rejections, edits, and the self-aware RL feedback loop). Never ask the user to repeat their profile.",
  );
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
    lines.push(`- See ${dp.splitPath}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderDomainProfileMarkdown(dp: Profile["domains"][string]): string {
  const lines: string[] = [];
  lines.push(`# ${dp.category}`);
  lines.push("");
  lines.push(
    "Composable sub-profile for this domain. Part of the project's profile.",
  );
  lines.push("");
  for (const p of dp.preferences) {
    lines.push(renderPreferenceLine(p));
  }
  return lines.join("\n");
}

function renderPreferenceLine(p: Preference): string {
  const prefix = p.pinned ? "Pinned: " : "";
  return `- ${prefix}${p.preference}. Confidence: ${p.confidence.toFixed(2)}`;
}

export async function syncProfileFromDisk(projectRoot: string): Promise<void> {
  const rootMdPath = `${projectRoot.replace(/\/$/, "")}/.terax/profile.md`;
  let rootMd: string | null = null;
  try {
    const r = await native.readFile(rootMdPath);
    if (r.kind === "text") rootMd = r.content;
  } catch {
    return;
  }
  if (!rootMd) return;

  const parsed = await parseProfileMarkdown(rootMd, projectRoot);
  const existing = await storage.getProfile("project", projectRoot);
  if (!existing) return;

  const updatedPrefs: Preference[] = [];

  for (const parsedPref of parsed.preferences) {
    // Prevent duplicates in parsed preferences (exact normalized match only; no fuzzy/similarity).
    // Manual edits to .terax/*.md are the source of truth for pinning/text; LLM refinement will
    // re-consolidate on next pass.
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const duplicate = updatedPrefs.find(
      (p) =>
        p.category === parsedPref.category &&
        norm(p.preference) === norm(parsedPref.preference),
    );
    if (duplicate) {
      duplicate.pinned = duplicate.pinned || parsedPref.pinned;
      duplicate.confidence = Math.max(
        duplicate.confidence,
        parsedPref.confidence,
      );
      continue;
    }

    const matched = existing.preferences.find(
      (p) =>
        p.category === parsedPref.category &&
        norm(p.preference) === norm(parsedPref.preference),
    );

    if (matched) {
      updatedPrefs.push({
        ...matched,
        preference: parsedPref.preference,
        confidence: parsedPref.confidence,
        pinned: parsedPref.pinned,
      });
    } else {
      updatedPrefs.push({
        id: newPreferenceId(),
        category: parsedPref.category as Domain,
        preference: parsedPref.preference,
        confidence: parsedPref.confidence,
        evidenceCount: 1,
        firstObservedAt: Date.now(),
        lastObservedAt: Date.now(),
        signalIds: [],
        supportingSources: [],
        scope: "project",
        projectRoot,
        pinned: parsedPref.pinned,
        supersededBy: null,
      });
    }
  }

  const profile: Profile = {
    ...existing,
    generatedAt: Date.now(),
    preferences: updatedPrefs,
  };

  const domains: Record<string, any> = {};
  for (const p of updatedPrefs) {
    const domain = p.category;
    let dp = domains[domain];
    if (!dp) {
      dp = {
        category: domain,
        summary: "",
        preferences: [],
        updatedAt: Date.now(),
        split: existing.domains[domain]?.split ?? false,
        splitPath: existing.domains[domain]?.splitPath ?? null,
      };
      domains[domain] = dp;
    }
    dp.preferences.push(p);
  }

  for (const [k, v] of Object.entries(existing.domains)) {
    if (!domains[k]) {
      domains[k] = {
        ...v,
        preferences: [],
        updatedAt: Date.now(),
      };
    }
  }

  const { generateDomainSummary, generateSummary } = await import(
    "./refinement"
  );

  for (const dp of Object.values(domains)) {
    dp.preferences.sort(
      (a: Preference, b: Preference) => b.confidence - a.confidence,
    );
    dp.summary = generateDomainSummary(dp.category, dp.preferences);
  }

  profile.domains = domains;
  profile.summary = generateSummary(updatedPrefs, DEFAULT_REFINEMENT_CONFIG);

  // Note the self-write so the fs watcher events from this write don't immediately
  // re-trigger syncProfileFromDisk via notifyUserFileEdit.
  noteProfileSelfWrite();

  fsMirrorDisabled = true;
  try {
    await storage.saveProfile(profile);
    // We intentionally do not write profile.json here anymore.
    // profile.md is the source for humans and for loading artifacts.
  } finally {
    fsMirrorDisabled = false;
  }
}

async function parseProfileMarkdown(
  rootMdContent: string,
  workspaceRoot: string,
): Promise<{
  preferences: {
    category: string;
    preference: string;
    confidence: number;
    pinned: boolean;
  }[];
}> {
  const preferences: {
    category: string;
    preference: string;
    confidence: number;
    pinned: boolean;
  }[] = [];

  const lines = rootMdContent.split("\n");
  let currentCategory = "general";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("# ")) {
      const heading = trimmed.slice(2).trim();
      const cleanHeading = heading
        .replace(/\s*\(Continuously Learned by Terax\)/i, "")
        .replace(/^Taste\s*[-—]?\s*/i, "")
        .trim();
      const lower = cleanHeading.toLowerCase();
      if (lower !== "engineering profile" && lower !== "profile" && lower !== "taste") {
        currentCategory = cleanHeading.toLowerCase();
      }
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const bulletText = trimmed.slice(2).trim();

      const splitMatch = bulletText.match(/See\s+([^\s(]+)/i);
      if (splitMatch) {
        const relPath = splitMatch[1];
        const absPath = `${workspaceRoot.replace(/\/$/, "")}/${relPath.replace(/^\//, "")}`;
        try {
          const fileRes = await native.readFile(absPath);
          if (fileRes.kind === "text") {
            const splitPrefs = await parseDomainProfileMarkdown(
              fileRes.content,
              currentCategory,
            );
            preferences.push(...splitPrefs);
          }
        } catch (err) {
          console.warn(
            `[engineering-profile] Failed to read split profile at ${absPath}:`,
            err,
          );
        }
        continue;
      }

      const pref = parsePreferenceLine(bulletText, currentCategory);
      if (pref) {
        preferences.push(pref);
      }
    }
  }

  return { preferences };
}

async function parseDomainProfileMarkdown(
  content: string,
  category: string,
): Promise<
  {
    category: string;
    preference: string;
    confidence: number;
    pinned: boolean;
  }[]
> {
  const preferences: {
    category: string;
    preference: string;
    confidence: number;
    pinned: boolean;
  }[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      const bulletText = trimmed.slice(2).trim();
      const pref = parsePreferenceLine(bulletText, category);
      if (pref) {
        preferences.push(pref);
      }
    }
  }
  return preferences;
}

function parsePreferenceLine(
  text: string,
  category: string,
): {
  category: string;
  preference: string;
  confidence: number;
  pinned: boolean;
} | null {
  const confidenceRegex = /Confidence:\s*([0-9.]+)/i;
  const match = text.match(confidenceRegex);
  let confidence = 0.5;
  let cleanText = text;

  if (match) {
    confidence = parseFloat(match[1]);
    cleanText = text.replace(confidenceRegex, "").trim();
    if (cleanText.endsWith(".")) {
      cleanText = cleanText.slice(0, -1).trim();
    }
  }

  cleanText = cleanText.replace(/\s*\([^)]+\)$/g, "").trim();
  if (cleanText.endsWith(".")) {
    cleanText = cleanText.slice(0, -1).trim();
  }

  let pinned = false;
  if (cleanText.toLowerCase().startsWith("pinned:")) {
    pinned = true;
    cleanText = cleanText.slice(7).trim();
  }

  if (!cleanText) return null;

  return {
    category,
    preference: cleanText,
    confidence,
    pinned,
  };
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
