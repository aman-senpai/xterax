/**
 * Persisted skill configuration and management types.
 *
 * Agent Skills follow the agentskills.io specification: each skill lives in a
 * directory with a SKILL.md file that has YAML frontmatter (name, description)
 * and markdown body (the skill instructions).
 *
 * Skills can be:
 * - **Filesystem-discovered**: found in `.agents/skills/* /SKILL.md` or
 *   `.xterax/skills/* /SKILL.md` (project or user scope). Metadata is parsed
 *   from frontmatter; the body is read on activation.
 * - **Custom**: created from the Settings UI. Stored entirely in preferences
 *   with inline content (no filesystem directory required).
 *
 * The `skillsConfigs` preference stores enable/disable state for discovered
 * skills and full definitions for custom skills. At runtime, discovered skills
 * are merged with configs — disabled skills are filtered out.
 */

/** Unique identifier — UUID v4 or random 8-char hex. */
export type SkillId = string;

/**
 * Persisted configuration for a single skill.
 *
 * For filesystem-discovered skills, only id/name/enabled are persisted
 * (the rest comes from discovery at runtime). For custom skills created in
 * settings, all fields are persisted.
 */
export type SkillConfig = {
  /** Stable unique id (crypto.randomUUID().slice(0, 8)). */
  id: SkillId;
  /** Skill name (must match directory name for filesystem skills). */
  name: string;
  /** Short description shown in the skill catalog. */
  description: string;
  /** Absolute path to SKILL.md (filesystem skills only). */
  location?: string;
  /** Absolute path to the skill directory (filesystem skills only). */
  baseDir?: string;
  /** Discovery source. */
  source: "project" | "user" | "custom";
  /** Inline SKILL.md body content (custom skills only). */
  content?: string;
  /** Whether the skill is active. Disabled skills are excluded from the catalog. */
  enabled: boolean;
};

export function newSkillId(): SkillId {
  return crypto.randomUUID().slice(0, 8);
}

export function blankSkill(
  overrides?: Partial<SkillConfig>,
): SkillConfig {
  return {
    id: newSkillId(),
    name: "",
    description: "",
    source: "custom",
    enabled: true,
    ...overrides,
  };
}

/**
 * Derive a stable id from a skill name — used to match discovered skills
 * with their persisted configs across sessions.
 */
export function skillIdFromName(name: string): SkillId {
  // Simple hash-like id: take first 8 chars of a deterministic slug.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Use a simple djb2 hash to get stable hex.
  let hash = 5381;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) + hash + slug.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}
