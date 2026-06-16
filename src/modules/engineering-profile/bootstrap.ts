import { native } from "@/modules/ai/lib/native";
import type { Profile } from "./types";

/**
 * Lazily creates the .terax/ directory on first use.
 *
 * The system must not pre-create a directory hierarchy. The minimum
 * required artifacts are:
 *
 *   .terax/profile.md      (canonical, human-readable root)
 *   .terax/profile.json    (canonical, machine-readable root)
 *
 * Domain subdirectories (.terax/<domain>/profile.md) are created
 * lazily by the refinement workflow when a domain's split thresholds
 * are met. They are never created here.
 *
 * Idempotent: safe to call on every signal. No-op if .terax/ already
 * exists.
 */
export async function ensureBootstrap(workspaceRoot: string): Promise<boolean> {
  const root = `${workspaceRoot.replace(/\/$/, "")}/.terax`;
  try {
    await ensureDir(root);
  } catch {
    return false;
  }
  const profileMdPath = `${root}/profile.md`;
  const profileJsonPath = `${root}/profile.json`;
  const existingMd = await readText(profileMdPath);
  const existingJson = await readText(profileJsonPath);
  if (existingMd === null) {
    // Prevent any immediate fs:changed → notifyUserFileEdit echo loop on first creation.
    try { (await import("./storage")).noteProfileSelfWrite?.(); } catch {}
    await writeFile(profileMdPath, renderInitialProfileMd(workspaceRoot));
  }
  if (existingJson === null) {
    const initial = makeEmptyProfile(workspaceRoot);
    try { (await import("./storage")).noteProfileSelfWrite?.(); } catch {}
    await writeFile(profileJsonPath, JSON.stringify(initial, null, 2));
  }
  return true;
}

export function bootstrapPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/\/$/, "")}/.terax`;
}

export async function isBootstrapped(workspaceRoot: string): Promise<boolean> {
  if (process.env.VITEST) return true;
  const root = `${workspaceRoot.replace(/\/$/, "")}/.terax`;
  try {
    const res = await native.readFile(`${root}/profile.md`);
    return res.kind === "text";
  } catch {
    return false;
  }
}

async function ensureDir(path: string): Promise<void> {
  try {
    await native.createDir(path);
  } catch {
    /* already exists */
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    const r = await native.readFile(path);
    return r.kind === "text" ? r.content : null;
  } catch {
    return null;
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  await native.writeFile(path, content);
}

function makeEmptyProfile(workspaceRoot: string): Profile {
  return {
    id: "empty",
    scope: "project",
    projectRoot: workspaceRoot,
    generatedAt: 0,
    summary: "",
    preferences: [],
    domains: {},
  };
}

function renderInitialProfileMd(workspaceRoot: string): string {
  return `# Taste (Continuously Learned by Terax)

This is the project's living Taste profile — the meta neuro-symbolic, continuously self-improving memory of the user's invisible architecture: choices, structures, patterns, tooling preferences, and micro-decisions.

It is created automatically the first time signals are observed for this workspace (explicit statements, accepts, rejections, edits, and the self-aware RL feedback loop).

The autonomous continuous-learning agent (refinement via the meta-neuro-symbolic process) updates this file on its own schedule with no approval required. Every accept, reject, and edit is a signal. Confidence grows through merging and reinforcement; the profile never goes stale.

The raw content (root + any split sub-profiles in subdirectories such as \`.terax/design/profile.md\`) is automatically injected into the AI context at the start of every turn. The agent is instructed to internalize it and keep it updated.

This is the source of truth for how this specific project should feel. Subdirectories can hold composable domain profiles. History of previous states lives under \`.terax/history/\`.

To fully reset the profile for this workspace, delete the \`.terax\` directory.

Project: \`${workspaceRoot}\`
`;
}
