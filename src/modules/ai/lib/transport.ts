import {
  notifyChatTurnFinished as notifyTurnFinished,
  notifyUserMessageSent,
  setAgentProjectRoot,
  startLearningAgent as startAgent,
} from "@/modules/engineering-profile/learningAgent";
import { observeUserMessage } from "@/modules/engineering-profile/observer";
import {
  anchorProjectRoot,
  resolveProfileProjectRoot,
} from "@/modules/engineering-profile/projectRoot";
import { ensureBootstrap } from "@/modules/engineering-profile";
import type { ContextPackage } from "@/modules/engineering-profile/runtime";
import {
  buildContextPackage,
  loadProfileArtifacts,
  renderContextPackageForPrompt,
} from "@/modules/engineering-profile/runtime";
import type { UIMessage } from "@ai-sdk/react";
import type { CustomEndpoint } from "../config";
import type { ToolContext } from "../tools/tools";
import { type AgentUsageDelta, runAgentStream } from "./agent";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { native } from "./native";
import { getSkills } from "../skills/skills";
import { applyOverrides, type PromptKey } from "./prompts";
import type { SkillConfig } from "@/modules/skills/types";

const XTERAX_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();
const profilePackageCache = new Map<
  string,
  { pkg: ContextPackage | null; mtime: number }
>();
const PROFILE_PACKAGE_TTL_MS = 30_000;
const bootstrappedProjects = new Set<string>();

async function readXteraxMd(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/XXTERAX.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, {
        content: null,
        mtime: Date.now(),
      });
      return null;
    }
    const content =
      r.content.length > XTERAX_MD_MAX_BYTES
        ? r.content.slice(0, XTERAX_MD_MAX_BYTES)
        : r.content;
    projectMemoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}

async function loadProfilePackage(
  workspaceRoot: string | null,
  taskText: string,
): Promise<ContextPackage | null> {
  const cacheKey = `${workspaceRoot ?? ""}::${taskText.slice(0, 240)}`;
  const cached = profilePackageCache.get(cacheKey);
  if (cached && Date.now() - cached.mtime < PROFILE_PACKAGE_TTL_MS) {
    return cached.pkg;
  }
  try {
    const pkg = await buildContextPackage({
      taskText,
      projectRoot: workspaceRoot,
    });
    profilePackageCache.set(cacheKey, { pkg, mtime: Date.now() });
    return pkg;
  } catch (err) {
    console.warn("[engineering-profile] package build failed:", err);
    profilePackageCache.set(cacheKey, { pkg: null, mtime: Date.now() });
    return null;
  }
}

function lastUserTaskText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let acc = "";
    for (const p of parts) {
      if (p.type === "text" && p.text) acc += `${p.text}\n`;
    }
    if (acc.trim()) return acc.trim();
  }
  return "";
}

/**
 * Runs LLM intent observation on the latest user-authored message only.
 * Must complete before refinement so signals are visible to the extractor.
 */
async function observeLatestUserMessage(
  messages: UIMessage[],
  projectRoot: string | null,
): Promise<void> {
  const text = extractLatestUserText(messages);
  if (!text) return;
  try {
    await observeUserMessage({ text, projectRoot });
  } catch (err) {
    console.warn("[engineering-profile] observeLatestUserMessage failed:", err);
  }
}

function extractLatestUserText(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    const chunks: string[] = [];
    for (const p of parts) {
      if (p.type !== "text" || !p.text) continue;
      const cleaned = stripInjectedBlocks(p.text);
      if (cleaned) chunks.push(cleaned);
    }
    const joined = chunks.join("\n").trim();
    if (joined.length >= 4) return joined;
  }
  return null;
}

function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<env>[\s\S]*?<\/env>/g, "")
    .replace(/<file [^>]*>[\s\S]*?<\/file>/g, "")
    .replace(/<selection[^>]*>[\s\S]*?<\/selection>/g, "")
    .replace(/<xterax-command[^>]*\/>/g, "")
    .trim();
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  /** Active session mode overlay (Plan / Review / custom). */
  getModeOverlay?: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  /**
   * Stable project root — the directory Xterax was opened in. Distinct
   * from `getLive().workspaceRoot` which follows the active terminal's
   * cwd. Used as the anchor for the engineering profile directory so
   * navigating between subdirectories via `cd` does not relocate the
   * `.xterax/` profile directory.
   */
  getProjectRoot?: () => string | null;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getOpenaiCompatibleContextLimit?: () => number | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  onTurnFinish?: () => void;
  getPlanMode?: () => boolean;
  getThinkingLevel?: () => string;
  getSkillsConfigs?: () => SkillConfig[];
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    // Resolve using current live context (follows active terminal) then
    // normalize to git root + anchor. This is what makes profile target the
    // right project when the user is working in xterax-ai (or any other
    // checkout) instead of whatever launchCwd was.
    const contextDir = deps.getProjectRoot?.() ?? live.workspaceRoot ?? null;
    const resolved = await resolveProfileProjectRoot(contextDir);
    const projectRoot = anchorProjectRoot(resolved) ?? resolved ?? contextDir;
    if (projectRoot) {
      setAgentProjectRoot(projectRoot);
      if (!bootstrappedProjects.has(projectRoot)) {
        bootstrappedProjects.add(projectRoot);
        void startAgent(projectRoot);
      }
      // Create (or ensure) the minimal .xterax/profile.md skeleton (# Profile only)
      // as soon as we have a project context for a chat. The skeleton has no
      // content (only the heading) so loadProfileArtifacts + isSkeletonProfileMd
      // treat it as absent for injection. This guarantees .xterax/ exists for
      // agent inspection and learning, even if the user just started a fresh
      // session or the previous message didn't contain a preference statement.
      // Real content is only written later by refinement.
      await ensureBootstrap(projectRoot).catch(() => {});
    }
    await observeLatestUserMessage(options.messages, projectRoot);
    // Yield one microtask so recordSignal → notifySignalRecorded can run
    // before refinement (signals.ts schedules via queueMicrotask).
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    if (projectRoot) notifyUserMessageSent(projectRoot);

    // Discover agent skills (cached per workspace root).
    // Merge with managed skill configs from preferences (enable/disable,
    // custom inline skills).
    const skillsConfigs = deps.getSkillsConfigs?.() ?? [];
    const skills = live.workspaceRoot
      ? await getSkills(live.workspaceRoot, skillsConfigs)
      : null;

    // Load prompt overrides from .xterax/prompts/ (cached per workspace).
    if (live.workspaceRoot) {
      await loadPromptOverridesForWorkspace(live.workspaceRoot);
    }

    const projectMemory = await readXteraxMd(live.workspaceRoot);
    const profileArtifacts = projectRoot
      ? await loadProfileArtifacts(projectRoot, 4000)
      : null;
    // profileContent provides the raw .xterax/profile.md (root + splits) as passive
    // context in the stable system prompt, exactly like XXTERAX.md. This fulfills
    // "provide the profile.md file as context" without requiring the chat agent
    // to use any learning tools or know the machinery.
    const profileContent = profileArtifacts?.rootBody ?? null;
    const taskText = lastUserTaskText(options.messages);
    const profilePkg = taskText
      ? await loadProfilePackage(projectRoot, taskText)
      : null;
    const profileBlock = profilePkg
      ? renderContextPackageForPrompt(profilePkg)
      : "";
    const artifactsBlock =
      profileArtifacts && profileArtifacts.rootBody.trim().length > 0
        ? `<profile-artifacts paths="${
            profileArtifacts.includedSplits.join(", ") || "(root only)"
          }" tokens="${profileArtifacts.totalTokens}">\n${profileArtifacts.rootBody}\n</profile-artifacts>`
        : "";
    const envBlock = formatEnvBlock(live);
    let messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;
    const profileInjection = artifactsBlock || profileBlock;
    if (profileInjection) {
      messagesForRun = injectEngineeringProfile(
        messagesForRun,
        profileInjection,
      );
    }
    const turnSnapshot: {
      text: string;
      toolCalls: { toolName: string; input: Record<string, unknown> }[];
    } = { text: "", toolCalls: [] };
    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: deps.getCustomInstructions(),
      agentPersona: deps.getAgentPersona(),
      modeOverlay: deps.getModeOverlay?.() ?? null,
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      onStepFinishForProfile: (step) => {
        if (step.text) turnSnapshot.text = `${turnSnapshot.text}\n${step.text}`;
        turnSnapshot.toolCalls.push(...step.toolCalls);
      },
      onTurnFinish: () => {
        deps.onTurnFinish?.();
        notifyTurnFinished({
          sessionId: `turn-${Date.now().toString(36)}`,
          projectRoot,
          text: turnSnapshot.text,
          toolCalls: turnSnapshot.toolCalls,
          timestamp: Date.now(),
        });
      },
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      mlxBaseURL: deps.getMlxBaseURL?.(),
      mlxModelId: deps.getMlxModelId?.(),
      ollamaBaseURL: deps.getOllamaBaseURL?.(),
      ollamaModelId: deps.getOllamaModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      openaiCompatibleContextLimit: deps.getOpenaiCompatibleContextLimit?.(),
      openrouterModelId: deps.getOpenrouterModelId?.(),
      customEndpoints: deps.getCustomEndpoints?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      planMode: deps.getPlanMode?.(),
      thinkingLevel: (deps.getThinkingLevel?.() ??
        "off") as import("./thinking").ThinkingLevel,
      projectMemory,
      profileContent,
      skills,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

function injectEngineeringProfile(
  messages: UIMessage[],
  block: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: block }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx ? { ...p, text: `${p.text ?? ""}\n\n${block}` } : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: envBlock }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx
              ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
              : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}

// ---------------------------------------------------------------------------
// Prompt override loading
// ---------------------------------------------------------------------------

const promptOverridesLoaded = new Set<string>();

/**
 * Load prompt overrides from `.xterax/prompts/<key>.md` for the given
 * workspace root. Idempotent per workspace root — subsequent calls are
 * no-ops. Reads are best-effort; failures are silently ignored.
 */
async function loadPromptOverridesForWorkspace(
  workspaceRoot: string,
): Promise<void> {
  if (promptOverridesLoaded.has(workspaceRoot)) return;
  promptOverridesLoaded.add(workspaceRoot);

  const promptsDir = `${workspaceRoot.replace(/\/$/, "")}/.xterax/prompts`;
  const keyToFileName = (k: string) => k.replace(/:/g, "-");

  // Build a map of known prompt keys to their file names.
  const overrides: Partial<Record<string, string>> = {};

  // Try to read each known prompt key's override file.
  const promptKeys = [
    "system", "system-lite", "engineering-profile", "plan-mode",
    "subagent-system", "title-generation", "autocomplete-system",
    "autocomplete-user", "init-command",
    "continue-message", "elision-text",
    "agent-xterax", "agent-coder", "agent-architect", "agent-reviewer",
    "agent-security", "agent-designer", "agent-verification", "skills-preamble",
  ];

  for (const key of promptKeys) {
    try {
      const filePath = `${promptsDir}/${keyToFileName(key)}.md`;
      const result = await native.readFile(filePath);
      if (result.kind === "text" && result.content.trim()) {
        overrides[key] = result.content.trim();
      }
    } catch {
      // File doesn't exist or isn't readable — skip
    }
  }

  if (Object.keys(overrides).length > 0) {
    applyOverrides(overrides as Partial<Record<PromptKey, string>>);
  }
}
