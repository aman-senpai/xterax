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
    await writeFile(profileMdPath, renderInitialProfileMd(workspaceRoot));
  }
  if (existingJson === null) {
    const initial = makeEmptyProfile(workspaceRoot);
    await writeFile(profileJsonPath, JSON.stringify(initial, null, 2));
  }
  return true;
}

export function bootstrapPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/\/$/, "")}/.terax`;
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
  return `# Engineering Profile (Continuously Learned by Terax)

This is the root memory artifact for Terax's continuous-learning agent. It is created automatically the first time a preference signal is recorded for this workspace.

The autonomous continuous-learning agent updates this file on its own schedule. Edits happen without approval — they are based on observed preferences, tool calls, and user feedback across sessions. Each preference carries a confidence score in [0, 1] that increases with repeated evidence and decays with disuse.

The agent always loads this file at the start of every new chat. As the profile grows, the autonomous agent may split large domains into their own subdirectory files (e.g. \`./design/profile.md\`) when thresholds are met. The root file will then reference those.

To reset the profile for this workspace, delete this directory.

Project: \`${workspaceRoot}\`
`;
}
