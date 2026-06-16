import type { UIMessage } from "@ai-sdk/react";
import type { CustomEndpoint } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import type { ProviderKeys, CustomEndpointKeys } from "./keyring";
import { native } from "./native";
import type { ToolContext } from "../tools/tools";
import {
  buildContextPackage,
  loadProfileArtifacts,
  renderContextPackageForPrompt,
} from "@/modules/engineering-profile/runtime";
import type { ContextPackage } from "@/modules/engineering-profile/runtime";
import { anchorProjectRoot } from "@/modules/engineering-profile/projectRoot";
import { observeUserMessage } from "@/modules/engineering-profile/observer";
import { ensureBootstrap } from "@/modules/engineering-profile/bootstrap";
import {
  startLearningAgent as startAgent,
  setAgentProjectRoot,
  notifyChatTurnFinished as notifyTurnFinished,
} from "@/modules/engineering-profile/learningAgent";

const TERAX_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();
const profilePackageCache = new Map<
  string,
  { pkg: ContextPackage | null; mtime: number }
>();
const PROFILE_PACKAGE_TTL_MS = 30_000;
const bootstrappedProjects = new Set<string>();

async function readTeraxMd(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/TERAX.md`;
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
      r.content.length > TERAX_MD_MAX_BYTES
        ? r.content.slice(0, TERAX_MD_MAX_BYTES)
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
 * Runs the passive observer against every user message in this turn.
 * Captures explicit preference patterns ("I prefer X", "always use Y")
 * even when the agent doesn't proactively call the recording tool.
 *
 * Skips text wrapped in <env> or <file> tags (those are system-injected,
 * not user-authored). Fire-and-forget; the chat run is not blocked.
 *
 * Signals notify the learning agent; refinement runs after the turn ends.
 */
async function observeForProfile(
  messages: UIMessage[],
  projectRoot: string | null,
): Promise<void> {
  try {
    for (const m of messages) {
      if (m.role !== "user") continue;
      const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
      for (const p of parts) {
        if (p.type !== "text" || !p.text) continue;
        const cleaned = stripInjectedBlocks(p.text);
        if (cleaned.trim().length < 4) continue;
        await observeUserMessage({
          text: cleaned,
          projectRoot,
        });
      }
    }
  } catch (err) {
    console.warn("[engineering-profile] observeForProfile failed:", err);
  }
}

function stripInjectedBlocks(text: string): string {
  return text
    .replace(/<env>[\s\S]*?<\/env>/g, "")
    .replace(/<file [^>]*>[\s\S]*?<\/file>/g, "")
    .replace(/<selection[^>]*>[\s\S]*?<\/selection>/g, "")
    .replace(/<terax-command[^>]*\/>/g, "")
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
  getLive: () => LiveSnapshot;
  /**
   * Stable project root — the directory Terax was opened in. Distinct
   * from `getLive().workspaceRoot` which follows the active terminal's
   * cwd. Used as the anchor for the engineering profile directory so
   * navigating between subdirectories via `cd` does not relocate the
   * `.terax/` profile directory.
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
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const liveRoot = live.workspaceRoot;
    const projectRoot =
      anchorProjectRoot(deps.getProjectRoot?.() ?? liveRoot) ?? liveRoot;
    if (projectRoot) {
      setAgentProjectRoot(projectRoot);
      if (!bootstrappedProjects.has(projectRoot)) {
        bootstrappedProjects.add(projectRoot);
        void startAgent(projectRoot);
      }
      // Eagerly ensure the .terax/profile.md (and .json) skeleton exists
      // for this anchored project. This guarantees that loadProfileArtifacts
      // will always succeed in reading and injecting the raw on-disk
      // Engineering Profile (as the <profile-artifacts> block) into every
      // AI chat turn/context for the project — even before the first
      // preference signal or refinement. The system prompt explicitly
      // tells the model that this is auto-injected and that it must
      // maintain it. ensureBootstrap is a no-op if the files already exist.
      void ensureBootstrap(projectRoot).catch(() => {});
    }
    await observeForProfile(options.messages, projectRoot);
    const projectMemory = await readTeraxMd(live.workspaceRoot);
    const profileArtifacts = projectRoot
      ? await loadProfileArtifacts(projectRoot, 4000)
      : null;
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
