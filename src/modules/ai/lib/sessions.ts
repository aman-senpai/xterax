import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { CustomEndpoint } from "../config";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { getTitleGenerationPrompt } from "./prompts";

export type SessionBackend = "local" | "acp";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Chat runtime backend. Omitted / undefined means local (AI SDK). */
  backend?: SessionBackend;
  /** Configured ACP agent id when backend is "acp". */
  acpAgentId?: string;
};

const STORE_PATH = "xterax-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const messagesKey = (id: string) => `messages:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSessions> {
  // One IPC roundtrip via entries() rather than two parallel get()s. Per-
  // session messages are loaded lazily via `loadMessages` only when a
  // session is opened, so cold boot stays at a single store call.
  const entries = await store.entries();
  let sessions: SessionMeta[] | undefined;
  let activeId: string | null | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_SESSIONS) sessions = v as SessionMeta[];
    else if (k === KEY_ACTIVE) activeId = v as string | null;
  }
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  return (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await store.set(messagesKey(id), messages);
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}

export type TitleGenLocalConfig = {
  lmstudioBaseURL?: string;
  lmstudioModelId?: string;
  mlxBaseURL?: string;
  mlxModelId?: string;
  ollamaBaseURL?: string;
  ollamaModelId?: string;
  openaiCompatibleBaseURL?: string;
  openaiCompatibleModelId?: string;
  openrouterModelId?: string;
  customEndpoints?: readonly CustomEndpoint[];
  customEndpointKeys?: CustomEndpointKeys;
};

export async function generateSessionTitle(
  messages: UIMessage[],
  modelId: string,
  keys: ProviderKeys,
  local: TitleGenLocalConfig,
): Promise<string | null> {
  const context = buildTitlePromptContext(messages);
  if (!context) return null;

  try {
    const [{ buildConfiguredLanguageModel }, { generateText }] =
      await Promise.all([import("@/modules/ai/lib/agent"), import("ai")]);

    const model = await buildConfiguredLanguageModel(modelId, keys, {
      lmstudioBaseURL: local.lmstudioBaseURL,
      lmstudioModelId: local.lmstudioModelId,
      mlxBaseURL: local.mlxBaseURL,
      mlxModelId: local.mlxModelId,
      ollamaBaseURL: local.ollamaBaseURL,
      ollamaModelId: local.ollamaModelId,
      openaiCompatibleBaseURL: local.openaiCompatibleBaseURL,
      openaiCompatibleModelId: local.openaiCompatibleModelId,
      openrouterModelId: local.openrouterModelId,
      customEndpoints: local.customEndpoints,
      customEndpointKeys: local.customEndpointKeys,
    });

    const { text } = await generateText({
      model,
      system: getTitleGenerationPrompt(),
      prompt: context,
      maxOutputTokens: 40,
      temperature: 0.2,
      maxRetries: 0,
    });

    return cleanLlmTitle(text);
  } catch {
    return null;
  }
}

function buildTitlePromptContext(messages: UIMessage[]): string | null {
  const parts: string[] = [];
  let users = 0;
  for (const m of messages) {
    if (m.role === "user") {
      const t = cleanForTitle(extractTextContent(m)).slice(0, 700);
      if (t) {
        parts.push(`User: ${t}`);
        users++;
      }
    } else if (m.role === "assistant" && parts.length > 0) {
      const t = cleanForTitle(extractTextContent(m)).slice(0, 400);
      if (t) parts.push(`Assistant: ${t}`);
    }
    if (users >= 2) break;
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

function extractTextContent(m: UIMessage): string {
  let out = "";
  for (const p of m.parts ?? []) {
    if ((p as { type?: string }).type === "text") {
      out += `${(p as { text?: string }).text ?? ""}\n`;
    }
  }
  return out;
}

function cleanForTitle(s: string): string {
  return s
    .replace(/<terminal-context[\s\S]*?<\/terminal-context>/g, "")
    .replace(/<selection[\s\S]*?<\/selection>/g, "")
    .replace(/<file[\s\S]*?<\/file>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLlmTitle(raw: string): string | null {
  let t = (raw || "").trim();
  if (!t) return null;
  // strip code fences or leading labels
  t = t.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```/g, ""));
  t = t.replace(/^(title|name):\s*/i, "");
  // first line only
  t = t.split(/\r?\n/)[0].trim();
  // strip wrapping quotes/punct
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  t = t.replace(/[.!?;:,]+$/g, "").trim();
  // length bounds
  if (t.length < 3) return null;
  if (t.length > 72) {
    t = `${t.slice(0, 69).trim()}…`;
  }
  // word count soft guidance (3-9 words target)
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 9) {
    t = `${words.slice(0, 8).join(" ")}…`;
  }
  return t || null;
}
