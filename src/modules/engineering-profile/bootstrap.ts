import { native } from "@/modules/ai/lib/native";

/**
 * Lazily creates the .terax/ directory on first use.
 *
 * The system must not pre-create a directory hierarchy. The minimum
 * required artifact is:
 *
 *   .terax/profile.md      (human-readable root profile)
 *
 * Domain subdirectories (.terax/<domain>/profile.md) are created
 * lazily by the refinement workflow when a domain's split thresholds
 * are met. They are never created here.
 *
 * Idempotent: safe to call on every signal. No-op if .terax/ already
 * exists.
 */
export async function ensureBootstrap(workspaceRoot: string): Promise<boolean> {
  if (process.env.VITEST) return true;
  const root = `${workspaceRoot.replace(/\/$/, "")}/.terax`;
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



function renderInitialProfileMd(workspaceRoot: string): string {
  return `# Profile

Project: \`${workspaceRoot}\`
`;
}
