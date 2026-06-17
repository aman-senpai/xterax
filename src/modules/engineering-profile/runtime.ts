import { mergeProfiles, resolveConflict } from "./refinement";
import { storage, makeBlankProfile } from "./storage";
import { native } from "@/modules/ai/lib/native";
import type { Domain, LoadedProfiles, Preference, Profile } from "./types";
import { preferenceKey, similarity } from "./confidence";

const DOMAIN_KEYWORDS: Record<Domain, RegExp[]> = {
  architecture: [
    /\b(architect|architecture|service|microservice|monolith|module|boundary|domain[- ]driven|ddd|hexagonal|cqrs|event[- ]driven|saga|coupling|cohesion|scalab|trade[- ]off|adr|design decision|system design)\b/i,
  ],
  frontend: [
    /\b(react|vue|svelte|solid|next\.?js|remix|nuxt|tailwind|css|scss|sass|html|dom|component|jsx|tsx|hook|state management|redux|zustand|jotai|recoil|client[- ]side|server component|hydration|ssr|csr|bundle|webpack|vite|suspense|storybook|design system|tokens|tailwind)\b/i,
  ],
  backend: [
    /\b(api|rest|graphql|grpc|endpoint|route|handler|middleware|controller|service|repository|database|sql|postgres|mysql|sqlite|redis|kafka|rabbitmq|queue|worker|job|cron|webhook|express|fastapi|django|flask|gin|echo|hono|rust|node|server)\b/i,
  ],
  design: [
    /\b(design|figma|sketch|color|palette|typography|font|spacing|layout|grid|icon|illustration|brand|visual|motion|animation|logo)\b/i,
  ],
  ux: [
    /\b(ux|user experience|usability|accessibility|a11y|aria|wcag|interaction|onboarding|empty state|error message|microcopy|tooltip|modal|drawer|navigation|keyboard|focus|form|micro-?copy|information architecture)\b/i,
  ],
  testing: [
    /\b(test|spec|vitest|jest|mocha|pytest|cypress|playwright|coverage|mock|stub|fixture|integration test|unit test|e2e|end[- ]to[- ]end|tdd|regression|flake|assert|expect)\b/i,
  ],
  documentation: [
    /\b(document|docs|readme|jsdoc|tsdoc|rstac|typedoc|changelog|migration guide|comment|docstring|swagger|openapi)\b/i,
  ],
  workflow: [
    /\b(git|pr|pull request|merge|rebase|squash|commit|branch|workflow|pipeline|ci|cd|action|deploy|release|hotfix|monorepo|workspace|launch.json|task|ticket|linear|jira|standup)\b/i,
  ],
  general: [],
};

const DOMAIN_CO_OCCURRENCE: Partial<Record<Domain, Domain[]>> = {
  frontend: ["design", "ux"],
  backend: ["architecture"],
  design: ["frontend", "ux"],
  ux: ["frontend", "design"],
  architecture: ["backend"],
};

const MAX_TOKENS_PER_DOMAIN = 600;
const MAX_TOKENS_TOTAL = 1800;

export function classifyTask(taskText: string): Domain[] {
  if (!taskText) return ["general"];
  const scores: Partial<Record<Domain, number>> = {};
  for (const d of Object.keys(DOMAIN_KEYWORDS) as Domain[]) {
    const patterns = DOMAIN_KEYWORDS[d];
    let count = 0;
    for (const re of patterns) {
      const matches = taskText.match(re);
      if (matches) count += matches.length;
    }
    if (count > 0) scores[d] = count;
  }
  const sorted = (Object.entries(scores) as [Domain, number][])
    .filter(([d]) => d !== "general")
    .sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 2).map(([d]) => d);
  const expanded = new Set<Domain>(top);
  for (const d of top) {
    for (const co of DOMAIN_CO_OCCURRENCE[d] ?? []) expanded.add(co);
  }
  expanded.add("general");
  return Array.from(expanded);
}

export async function loadProfiles(
  projectRoot: string | null,
): Promise<LoadedProfiles> {
  const user =
    (await storage.getProfile("user", null)) ?? makeBlankProfile("user", null);
  const project = projectRoot
    ? ((await storage.getProfile("project", projectRoot)) ??
      makeBlankProfile("project", projectRoot))
    : null;
  return { user, project };
}

/**
 * Loads the on-disk profile artifacts. The agent always reads the root
 * `profile.md` first; split domains (if any) are discovered by scanning
 * for "- See .terax/<domain>/profile.md" references inside the root md.
 *
 * Returns the concatenated markdown, token-bounded.
 */
export async function loadProfileArtifacts(
  workspaceRoot: string | null,
  maxTokens: number = 6000,
): Promise<{
  rootBody: string;
  includedSplits: string[];
  truncated: boolean;
  totalTokens: number;
}> {
  if (!workspaceRoot) {
    return {
      rootBody: "",
      includedSplits: [],
      truncated: false,
      totalTokens: 0,
    };
  }
  const rootMdPath = `${workspaceRoot.replace(/\/$/, "")}/.terax/profile.md`;
  const rootBody = await readTextFile(rootMdPath);
  if (rootBody === null) {
    return {
      rootBody: "",
      includedSplits: [],
      truncated: false,
      totalTokens: 0,
    };
  }

  // Discover splits from the human-readable profile.md (the "- See ..." lines
  // emitted by renderProfileMarkdown when a domain is split).
  const splitPaths: string[] = [];
  const seeRe = /- See\s+([^\s)]+profile\.md)/gi;
  let m: RegExpExecArray | null;
  while ((m = seeRe.exec(rootBody)) !== null) {
    const p = m[1];
    if (p.startsWith(".terax/") || p.includes("/.terax/")) {
      splitPaths.push(p);
    }
  }
  const blocks: string[] = [rootBody];
  const includedSplits: string[] = [];
  let used = estimateTokens(rootBody);
  let truncated = false;
  for (const rel of splitPaths) {
    const abs = `${workspaceRoot.replace(/\/$/, "")}/${rel.replace(/^\//, "")}`;
    const body = await readTextFile(abs);
    if (body === null) continue;
    const tokens = estimateTokens(body);
    if (used + tokens > maxTokens) {
      truncated = true;
      break;
    }
    blocks.push(body);
    includedSplits.push(rel);
    used += tokens;
  }
  return {
    rootBody: blocks.join("\n\n"),
    includedSplits,
    truncated,
    totalTokens: used,
  };
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    const r = await native.readFile(path);
    return r.kind === "text" ? r.content : null;
  } catch {
    return null;
  }
}

/**
 * Build a condensed context package for a task. Loads only the relevant
 * profile segments based on the classified domains and renders them in a
 * compact, token-bounded form ready for injection into the agent prompt.
 */
export async function buildContextPackage(opts: {
  taskText: string;
  projectRoot: string | null;
  now?: number;
  maxTokensPerDomain?: number;
  maxTokensTotal?: number;
}): Promise<ContextPackage> {
  const now = opts.now ?? Date.now();
  const domains = classifyTask(opts.taskText);
  const { user, project } = await loadProfiles(opts.projectRoot);
  const merged = mergeProfiles(user, project, now);
  const perDomain = opts.maxTokensPerDomain ?? MAX_TOKENS_PER_DOMAIN;
  const total = opts.maxTokensTotal ?? MAX_TOKENS_TOTAL;
  const blocks: ContextBlock[] = [];
  let used = 0;
  for (const d of domains) {
    if (used >= total) break;
    const remaining = Math.max(0, total - used);
    const cap = Math.min(perDomain, remaining);
    const block = renderDomainBlock(merged, d, cap);
    if (block.body.trim().length === 0) continue;
    blocks.push(block);
    used += estimateTokens(block.body);
  }
  return {
    domains,
    blocks,
    globalSummary: merged.summary,
    profileId: merged.id,
    generatedAt: merged.generatedAt,
  };
}

export type ContextBlock = {
  domain: Domain;
  body: string;
  preferenceCount: number;
  truncated: boolean;
};

export type ContextPackage = {
  domains: Domain[];
  blocks: ContextBlock[];
  globalSummary: string;
  profileId: string;
  generatedAt: number;
};

function renderDomainBlock(
  merged: Profile,
  domain: Domain,
  maxTokens: number,
): ContextBlock {
  const dp = merged.domains[domain];
  if (!dp) return { domain, body: "", preferenceCount: 0, truncated: false };
  const items = dp.preferences.slice();
  const picked: string[] = [];
  let used = 0;
  let truncated = false;
  for (const p of items) {
    const line = `- (${formatConfidence(p.confidence)}) ${p.preference}`;
    const tokens = estimateTokens(line);
    if (used + tokens > maxTokens) {
      truncated = true;
      break;
    }
    picked.push(line);
    used += tokens;
  }
  return {
    domain,
    body: picked.join("\n"),
    preferenceCount: picked.length,
    truncated,
  };
}

export function renderContextPackageForPrompt(pkg: ContextPackage): string {
  if (pkg.blocks.length === 0) return "";
  const lines: string[] = [];
  lines.push(`<engineering-profile domains="${pkg.domains.join(",")}">`);
  for (const b of pkg.blocks) {
    lines.push(`# ${b.domain}`);
    if (b.body) lines.push(b.body);
  }
  lines.push("</engineering-profile>");
  return lines.join("\n");
}

export async function explainPreference(
  preferenceId: string,
  projectRoot: string | null,
): Promise<PreferenceExplanation | null> {
  const { user, project } = await loadProfiles(projectRoot);
  const merged = mergeProfiles(user, project, Date.now());
  const pref =
    merged.preferences.find((p) => p.id === preferenceId) ??
    user.preferences.find((p) => p.id === preferenceId) ??
    project?.preferences.find((p) => p.id === preferenceId) ??
    null;
  if (!pref) return null;
  const signals = await storage.loadSignals(pref.scope, pref.projectRoot);
  const relevant = signals.filter(
    (s) =>
      preferenceKey(s.category, s.preference) ===
      preferenceKey(pref.category, pref.preference),
  );
  const userPref =
    user.preferences.find(
      (p) =>
        preferenceKey(p.category, p.preference) ===
        preferenceKey(pref.category, pref.preference),
    ) ?? null;
  const projectPref =
    project?.preferences.find(
      (p) =>
        preferenceKey(p.category, p.preference) ===
        preferenceKey(pref.category, pref.preference),
    ) ?? null;
  const { overridden } = resolveConflict(userPref, projectPref);
  const breakdown: Partial<Record<string, number>> = {};
  let totalWeight = 0;
  for (const s of relevant) {
    breakdown[s.source] = (breakdown[s.source] ?? 0) + 1;
    totalWeight += s.weight;
  }
  return {
    preference: pref,
    effectiveScope: pref.scope,
    overriddenBy: overridden,
    evidence: relevant
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((s) => ({
        signalId: s.id,
        timestamp: s.timestamp,
        source: s.source,
        scope: s.scope,
        evidence: s.evidence,
        weight: s.weight,
      })),
    totalWeight,
    sourceBreakdown: breakdown,
  };
}

export type PreferenceExplanation = {
  preference: Preference;
  effectiveScope: "user" | "project";
  overriddenBy: Preference | null;
  evidence: {
    signalId: string;
    timestamp: number;
    source: string;
    scope: "user" | "project";
    evidence: string;
    weight: number;
  }[];
  totalWeight: number;
  sourceBreakdown: Partial<Record<string, number>>;
};

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function formatConfidence(c: number): string {
  return `${(c * 100).toFixed(0)}%`;
}

export { similarity };
