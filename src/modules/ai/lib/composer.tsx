import { usePreferencesStore } from "@/modules/settings/preferences";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import { getChat, useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { type SlashCommandMeta, tryRunSlashCommand } from "./slashCommands";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
};

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export const MAX_TEXT_INLINE = 200_000;
export const ACCEPTED_FILES =
  "image/*,.txt,.md,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.csv,.log,.env,.config,.conf,.ini,Dockerfile,.dockerfile";

type Voice = ReturnType<typeof useWhisperRecording>;

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | null) => Promise<void>;
  /** Attach a file by absolute path — used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

// Module-level selector — stable reference to avoid Zustand v5
// useSyncExternalStore consistency-check re-renders on array returns.
const selectPendingSelections = (s: ReturnType<typeof useChatStore.getState>) =>
  s.pendingSelections;

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore(selectPendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Re-focus the textarea when the agent finishes — but only if the user
  // hasn't moved focus elsewhere (e.g. terminal, editor). Otherwise the
  // agent would steal focus every time it completes a tool call or response.
  // Also drains queued messages when the agent becomes idle.
  const prevIsBusyRef = useRef(false);
  useEffect(() => {
    if (prevIsBusyRef.current && !isBusy) {
      const el = document.activeElement;
      const ta = textareaRef.current;
      // Auto-focus only when nothing is focused, body is focused, or focus
      // is already inside the composer textarea itself.
      if (!el || el === document.body || (ta && ta.contains(el))) {
        requestAnimationFrame(() => ta?.focus());
      }
      // Drain queued messages — send the oldest queued message.
      if (sessionId) {
        void (async () => {
          const { useQueueStore } = await import("../store/queueStore");
          const queued = useQueueStore.getState().dequeue(sessionId);
          if (!queued) return;
          const { beginTurnAndGetChat } = await import("../store/chatRuntime");
          const chat = beginTurnAndGetChat(sessionId);
          void chat.sendMessage({
            role: "user",
            parts: queued.parts,
          } as Parameters<typeof chat.sendMessage>[0]);
        })();
      }
    }
    prevIsBusyRef.current = isBusy;
  }, [isBusy, sessionId, textareaRef]);

  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        void attachFileByPath(path);
      }
    };
    window.addEventListener("xterax:ai-attach-file", onAttach);
    return () => window.removeEventListener("xterax:ai-attach-file", onAttach);
    // attachFileByPath is stable for our purposes (closes over setFiles only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor" ? "Editor selection" : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  const attachFileByPath = async (path: string) => {
    try {
      type ReadResult =
        | { kind: "text"; content: string; size: number }
        | { kind: "binary"; size: number }
        | { kind: "toolarge"; size: number; limit: number };
      const result = await invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
      if (result.kind !== "text") {
        // Binary/oversize files: skip (could surface a toast in future).
        console.warn("attachFileByPath: skipped non-text file", path, result);
        return;
      }
      const name = path.split("/").pop() || path;
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/plain",
          text: result.content,
          size: result.size,
        };
        return [...prev, att];
      });
      // Open the AI panel & focus the input so the user sees the chip.
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachFileByPath failed:", e);
    }
  };

  const submit = () => {
    const trimmed = value.trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the XTERAX.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let commandSource = trimmed;
    if (
      pickedCommands.length > 0 &&
      !trimmed.startsWith("/") &&
      !trimmed.startsWith("#")
    ) {
      commandSource = `#${pickedCommands[0].name} ${trimmed}`.trim();
    }
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const skills = usePreferencesStore.getState().skillsConfigs;
      const outcome = tryRunSlashCommand(commandSource, skills);
      if (outcome.kind === "handled") {
        setValue("");
        // Clear picked commands so a handled toggle command (e.g. /plan)
        // doesn't persist and intercept the next submitted message.
        setPickedCommands([]);
        if (outcome.toast) console.info(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<xterax-command name="${outcome.commandName}" />`;
        }
      }
    }

    const parts: MessagePart[] = [];
    const fileBlocks = files
      .filter((f) => f.kind === "text")
      .map(
        (f) =>
          `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.text ?? ""}\n</file>`,
      );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map(
        (f) =>
          `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`,
      );
    const { body: bodyAfterTokens, blocks: snippetBlocks } =
      expandSnippetTokens(effectiveText, useSnippetsStore.getState().snippets);
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(
        `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
      );
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });

    for (const f of files) {
      if (f.kind === "image" && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (!sessionId) return;

    if (isBusy) {
      // Queue the message — it will be sent automatically when the current
      // turn finishes.
      void import("../store/queueStore").then(({ useQueueStore }) => {
        useQueueStore.getState().enqueue(
          sessionId,
          parts,
          pickedSnippets.map((s) => s.handle),
          pickedCommands.map((c) => c.name),
        );
      });
      setValue("");
      setFiles([]);
      setPickedSnippets([]);
      setPickedCommands([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    const store = useChatStore.getState();
    store.patchAgentMeta({ hitStepCap: false, compactionNotice: null });
    if (!store.rightPanelOpen) store.openRightPanel();

    const session = store.sessions.find((s) => s.id === sessionId);

    void (async () => {
      const { parsePipelineProgram } = await import("./pipelineDsl");
      const { compilePipelineProgram } = await import("./pipelineCompile");
      const { useAgentsStore } = await import("../store/agentsStore");
      const prefs = usePreferencesStore.getState();
      const acpAgents = prefs.acpAgents.filter((a) => a.enabled);
      const source = composed || effectiveText;
      const loopOpts = prefs.pipelineLoops;
      const program = parsePipelineProgram(source, {
        defaultMax: loopOpts.defaultMax,
        absoluteMax: loopOpts.absoluteMax,
      });
      if (program) {
        const compiled = compilePipelineProgram(
          program,
          useAgentsStore.getState().all(),
          acpAgents,
        );
        if (compiled.error) {
          store.patchAgentMeta({ status: "error", error: compiled.error });
          return;
        }
        // Pipeline transcripts render in the local chat view.
        if (session?.backend === "acp") {
          store.setSessionBackend(sessionId, "local");
        }
        const pipelineParts: MessagePart[] = parts.map((p) => {
          if (p.type !== "text") return p;
          const display = p.text
            .replace(/\[agent:([a-z][a-z0-9-]*)\]/gi, "@$1")
            .replace(/[ \t]{2,}/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
          return {
            type: "text",
            text: display || program.body,
          };
        });
        const { runAgentPipeline } = await import("../agents/runPipeline");
        await runAgentPipeline({
          sessionId,
          compiled: compiled.program,
          userBody: program.body,
          userParts: pipelineParts.length > 0 ? pipelineParts : parts,
        });
        return;
      }

      if (session?.backend === "acp" && session.acpAgentId) {
        const textParts = parts
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n\n");
        const { useAcpStore } = await import("@/modules/acp");
        const prefs = usePreferencesStore.getState();
        const config = prefs.acpAgents.find((a) => a.id === session.acpAgentId);
        if (!config) {
          store.patchAgentMeta({
            status: "error",
            error: "ACP agent config not found",
          });
          return;
        }
        const cwd =
          store.live.getWorkspaceRoot() ||
          store.live.getProjectRoot() ||
          store.live.getCwd();
        if (!cwd) {
          store.patchAgentMeta({
            status: "error",
            error: "No workspace directory for ACP session",
          });
          return;
        }
        store.patchAgentMeta({ status: "streaming", error: null });
        try {
          await useAcpStore.getState().ensureSession({
            chatSessionId: sessionId,
            config,
            cwd,
            mcpServers: prefs.mcpServers,
          });
          await useAcpStore.getState().sendPrompt(sessionId, textParts);
          store.patchAgentMeta({ status: "idle" });
        } catch (e) {
          store.patchAgentMeta({
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      const { beginTurnAndGetChat } = await import("../store/chatRuntime");
      const chat = beginTurnAndGetChat(sessionId);
      void chat.sendMessage({ role: "user", parts } as Parameters<
        typeof chat.sendMessage
      >[0]);
    })();

    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const stop = () => {
    if (!sessionId) return;
    const session = useChatStore
      .getState()
      .sessions.find((s) => s.id === sessionId);
    if (session?.backend === "acp") {
      void import("@/modules/acp").then(({ useAcpStore }) => {
        void useAcpStore.getState().cancel(sessionId);
      });
      useChatStore.getState().patchAgentMeta({ status: "idle" });
      return;
    }
    void getChat(sessionId)?.stop();
    void import("../agents/runPipeline").then((m) => m.abortPipeline());
    void import("../agents/runSubagent").then((m) => m.abortSubagent());
  };

  const canSend =
    value.trim().length > 0 ||
    files.length > 0 ||
    pickedSnippets.length > 0 ||
    pickedCommands.length > 0;

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    attachFileByPath,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  if (file.type.startsWith("image/")) {
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType: file.type || "image/png",
      url,
      size: file.size,
    };
  }
  if (file.size > MAX_TEXT_INLINE) return null;
  const text = await file.text();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
