import { native } from "@/modules/ai/lib/native";
import { clearProjectData, isVitest, projectMirrorExists } from "./storage";

/**
 * Lazily creates the .xterax/ directory on first use.
 *
 * The system must not pre-create a directory hierarchy. The minimum
 * required artifact is:
 *
 *   .xterax/profile.md      (human-readable root profile)
 *
 * On initial creation this file contains *only* the heading (no project
 * path or descriptive content) to avoid polluting chat context before
 * any real preferences have been learned. Real content is written later
 * by refinement.
 *
 * Domain subdirectories (.xterax/<domain>/profile.md) are created
 * lazily by the refinement workflow when a domain's split thresholds
 * are met. They are never created here.
 *
 * Idempotent: safe to call on every signal. No-op if .xterax/ already
 * exists.
 */
/**
 * When the user deleted .xterax/, drop stale project-scoped store data
 * before recreating the skeleton mirror. Otherwise ensureBootstrap would
 * recreate profile.md and resurrect old preferences from the Tauri store.
 */
export async function resetProjectStoreIfMirrorMissing(
  workspaceRoot: string,
): Promise<void> {
  if (!(await projectMirrorExists(workspaceRoot))) {
    await clearProjectData(workspaceRoot);
  }
}

export async function ensureBootstrap(workspaceRoot: string): Promise<boolean> {
  if (isVitest()) return true;
  await resetProjectStoreIfMirrorMissing(workspaceRoot);
  const root = `${workspaceRoot.replace(/\/$/, "")}/.xterax`;
  try {
    await ensureDir(root);
  } catch {
    return false;
  }
  const profileMdPath = `${root}/profile.md`;
  const existingMd = await readText(profileMdPath);
  if (existingMd === null) {
    // Prevent any immediate fs:changed → notifyUserFileEdit echo loop on first creation.
    try { (await import("./storage")).noteProfileSelfWrite?.(); } catch {}
    await writeFile(profileMdPath, renderInitialProfileMd(workspaceRoot));
  }
  return true;
}

export function bootstrapPath(workspaceRoot: string): string {
  return `${workspaceRoot.replace(/\/$/, "")}/.xterax`;
}

export async function isBootstrapped(workspaceRoot: string): Promise<boolean> {
  if (isVitest()) return true;
  const root = `${workspaceRoot.replace(/\/$/, "")}/.xterax`;
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



function renderInitialProfileMd(_workspaceRoot: string): string {
  // Intentionally minimal: only the heading. No project path or boilerplate
  // on first creation. Real content is added later by refinement when actual
  // signals exist. This avoids injecting polluted/empty context into chats.
  return "# Profile\n";
}
