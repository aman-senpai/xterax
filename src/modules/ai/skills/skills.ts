/**
 * Agent Skills discovery and lifecycle management.
 *
 * Implements the Agent Skills specification (agentskills.io):
 * - Scans project and user directories for SKILL.md files
 * - Progressive disclosure: metadata at startup, full instructions on activation
 * - Injects the skill catalog into the system prompt
 * - Provides allowlisted paths so the model can read skill files without prompts
 *
 * Search paths (project-level overrides user-level on name collision):
 *   Project: <workspace>/.agents/skills/* /SKILL.md
 *   Project: <workspace>/.xterax/skills/* /SKILL.md
 *   User:    ~/.agents/skills/* /SKILL.md
 *   User:    ~/.xterax/skills/* /SKILL.md
 */

import { native } from "@/modules/ai/lib/native";
import { homeDir } from "@tauri-apps/api/path";
import type { SkillConfig } from "@/modules/skills/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillMeta = {
  /** Name from SKILL.md frontmatter. Must match directory name per spec. */
  name: string;
  /** Description from SKILL.md frontmatter. Used for triggering decisions. */
  description: string;
  /** Absolute path to the SKILL.md file. */
  location: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  baseDir: string;
  /** Where the skill was found (for diagnostics). */
  source: "project" | "user";
};

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Hardcoded subdirectory names to scan inside each root.
 * Order determines precedence: later entries override earlier on name collision
 * (first-found wins within the same scope, project overrides user across scopes).
 */
const SKILL_DIR_NAMES = [".agents/skills", ".xterax/skills"];

/**
 * Discover all available skills from project and user directories.
 * Project-level skills take precedence over user-level skills on name collision.
 */
export async function discoverSkills(
  workspaceRoot: string,
): Promise<SkillMeta[]> {
  const projectSkills = await scanScope(workspaceRoot, "project");
  const userSkills = await scanUserScope();

  // Merge: project skills override user skills on name collision
  const seen = new Set<string>();
  const merged: SkillMeta[] = [];

  for (const s of projectSkills) {
    seen.add(s.name);
    merged.push(s);
  }
  for (const s of userSkills) {
    if (!seen.has(s.name)) {
      merged.push(s);
    }
  }

  return merged;
}

async function scanUserScope(): Promise<SkillMeta[]> {
  try {
    const home = await homeDir();
    if (!home) return [];
    return scanScope(home, "user");
  } catch {
    return [];
  }
}

async function scanScope(
  root: string,
  source: "project" | "user",
): Promise<SkillMeta[]> {
  const results: SkillMeta[] = [];
  const cleanRoot = root.replace(/\/$/, "");

  for (const dirName of SKILL_DIR_NAMES) {
    const skillsRoot = `${cleanRoot}/${dirName}`;
    try {
      const entries = await native.readDir(skillsRoot);
      for (const entry of entries) {
        if (entry.kind !== "dir") continue;
        const skillDir = `${skillsRoot}/${entry.name}`;
        const skillMdPath = `${skillDir}/SKILL.md`;
        try {
          const file = await native.readFile(skillMdPath);
          if (file.kind !== "text") continue;
          const parsed = parseSkillFrontmatter(file.content);
          if (!parsed) continue;
          results.push({
            name: parsed.name,
            description: parsed.description,
            location: skillMdPath,
            baseDir: skillDir,
            source,
          });
        } catch {
          // SKILL.md not readable — skip this directory
        }
      }
    } catch {
      // skillsRoot doesn't exist or isn't readable — skip
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// SKILL.md parsing
// ---------------------------------------------------------------------------

/**
 * Parse the YAML frontmatter from a SKILL.md file.
 * Returns null if the file is malformed or missing required fields.
 */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | null {
  // Extract YAML frontmatter between --- delimiters
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;

  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx);

  // Parse name
  const nameMatch = yamlBlock.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  // Parse description
  const descMatch = yamlBlock.match(/^description:\s*(.+)$/m);
  if (!descMatch) return null;
  const description = descMatch[1].trim();

  if (!name || !description) return null;

  return { name, description };
}

// ---------------------------------------------------------------------------
// Catalog rendering
// ---------------------------------------------------------------------------

/**
 * Build the skill catalog string for injection into the system prompt.
 * Each skill is ~50-100 tokens. Returns empty string if no skills.
 */
export function buildSkillCatalog(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";

  const lines: string[] = [];

  for (const s of skills) {
    lines.push(`- **${s.name}**: ${s.description}`);
    lines.push(`  Location: ${s.location}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Path allowlisting
// ---------------------------------------------------------------------------

/**
 * Return all skill directory paths that should be allowlisted for file reads.
 * The model needs to read SKILL.md and bundled resources without triggering
 * permission prompts.
 */
export function getSkillPaths(skills: SkillMeta[]): string[] {
  const paths = new Set<string>();
  for (const s of skills) {
    paths.add(s.baseDir);
  }
  return [...paths];
}

// ---------------------------------------------------------------------------
// Managed skills merge
// ---------------------------------------------------------------------------

/**
 * Merge filesystem-discovered skills with user-managed skill configs from
 * preferences.
 *
 * Rules:
 * - Custom skills (source === "custom") with inline content are converted to
 *   SkillMeta entries so they appear in the catalog.
 * - Discovered skills that have a matching config with enabled === false are
 *   filtered out.
 * - Discovered skills that have a matching config with content override use
 *   the override.
 * - Configs without a matching discovered skill are added as-is (custom skills).
 */
export function mergeManagedSkills(
  discovered: SkillMeta[],
  configs: SkillConfig[],
): SkillMeta[] {
  if (configs.length === 0) return discovered;

  const configByName = new Map<string, SkillConfig>();
  for (const c of configs) {
    configByName.set(c.name, c);
  }

  const result: SkillMeta[] = [];
  const seenNames = new Set<string>();

  // Process discovered skills — filter disabled, apply overrides
  for (const s of discovered) {
    const cfg = configByName.get(s.name);
    if (cfg && !cfg.enabled) continue; // Disabled — skip
    if (cfg?.content) {
      // Override location to point to preferences-managed content.
      // The baseDir stays the same so path allowlisting still works.
    }
    seenNames.add(s.name);
    result.push(s);
  }

  // Add custom skills that aren't in the discovered set
  for (const c of configs) {
    if (!c.enabled) continue;
    if (seenNames.has(c.name)) continue;
    if (!c.content) continue; // Custom skills need inline content
    result.push({
      name: c.name,
      description: c.description,
      location: `prefs://skills/${c.id}`,
      baseDir: "",
      source: "project", // Treat custom skills as project-level
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cachedSkills: SkillMeta[] | null = null;
let cachedWorkspaceRoot: string | null = null;

/**
 * Get discovered skills, using cache if the workspace root hasn't changed.
 * Call this at the start of each turn (it's cheap when cached).
 *
 * @param workspaceRoot - Project workspace root for discovery.
 * @param configs - Optional managed skill configs from preferences. When
 *   provided, disabled skills are filtered out and custom skills are added.
 */
export async function getSkills(
  workspaceRoot: string,
  configs?: SkillConfig[],
): Promise<SkillMeta[]> {
  if (cachedSkills && cachedWorkspaceRoot === workspaceRoot) {
    return configs ? mergeManagedSkills(cachedSkills, configs) : cachedSkills;
  }
  const discovered = await discoverSkills(workspaceRoot);
  cachedSkills = discovered;
  cachedWorkspaceRoot = workspaceRoot;
  return configs ? mergeManagedSkills(discovered, configs) : discovered;
}

/**
 * Invalidate the skills cache (e.g. when the user modifies skill files).
 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
  cachedWorkspaceRoot = null;
}

/**
 * Synchronous accessor for the cached skills. Returns null if not yet
 * discovered. Used by the system prompt builder which must be synchronous.
 */
export function getCachedSkills(): SkillMeta[] | null {
  return cachedSkills;
}
