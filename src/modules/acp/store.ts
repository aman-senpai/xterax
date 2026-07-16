import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  acpCancel,
  acpConnect,
  acpDisconnect,
  acpPrompt,
  acpRespondPermission,
  acpSessionNew,
  acpSetConfigOption,
  acpSetMode,
} from "./client";
import { mergeSessionConfig, parseConfigOptions } from "./configOptions";
import { appendUserText, applyAcpUpdate } from "./mapUpdates";
import type {
  AcpAgentConfig,
  AcpConfigOption,
  AcpConnectionStatus,
  AcpMcpServer,
  AcpModeState,
  AcpPermissionRequest,
  AcpTranscriptMessage,
  AcpUpdateEvent,
} from "./types";
import type { McpServerConfig } from "@/modules/mcp/types";

export type AcpSessionBinding = {
  /** Xterax chat session id */
  chatSessionId: string;
  agentId: string;
  connectionId: string;
  acpSessionId: string;
  busy: boolean;
  error: string | null;
  /** Preferred: agent config options (mode / model / thought_level). */
  configOptions: AcpConfigOption[] | null;
  /** Legacy modes when agent does not send configOptions. */
  modes: AcpModeState | null;
};

type AcpState = {
  connections: AcpConnectionStatus[];
  /** chatSessionId → binding */
  bindings: Record<string, AcpSessionBinding>;
  /** acpSessionId → transcript */
  transcripts: Record<string, AcpTranscriptMessage[]>;
  pendingPermissions: AcpPermissionRequest[];
  listening: boolean;
  ensureListeners: () => Promise<void>;
  connectAgent: (config: AcpAgentConfig) => Promise<AcpConnectionStatus>;
  disconnect: (connectionId: string) => Promise<void>;
  ensureSession: (args: {
    chatSessionId: string;
    config: AcpAgentConfig;
    cwd: string;
    mcpServers?: McpServerConfig[];
  }) => Promise<AcpSessionBinding>;
  sendPrompt: (chatSessionId: string, text: string) => Promise<void>;
  cancel: (chatSessionId: string) => Promise<void>;
  respondPermission: (
    connectionId: string,
    requestId: number,
    outcome: "selected" | "cancelled",
    optionId?: string | null,
  ) => Promise<void>;
  setMode: (chatSessionId: string, modeId: string) => Promise<void>;
  setConfigOption: (
    chatSessionId: string,
    configId: string,
    value: string | boolean,
  ) => Promise<void>;
  getTranscript: (chatSessionId: string) => AcpTranscriptMessage[];
  getBinding: (chatSessionId: string) => AcpSessionBinding | undefined;
  clearBinding: (chatSessionId: string) => void;
};

let unlisteners: UnlistenFn[] = [];

function mcpToAcp(servers: McpServerConfig[]): AcpMcpServer[] {
  return servers
    .filter((s) => s.enabled)
    .map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })),
    }));
}

function patchBindingsByAcpSession(
  bindings: Record<string, AcpSessionBinding>,
  acpSessionId: string,
  patch: Partial<AcpSessionBinding>,
): Record<string, AcpSessionBinding> {
  const next = { ...bindings };
  for (const [k, b] of Object.entries(next)) {
    if (b.acpSessionId === acpSessionId) {
      next[k] = { ...b, ...patch };
    }
  }
  return next;
}

export const useAcpStore = create<AcpState>((set, get) => ({
  connections: [],
  bindings: {},
  transcripts: {},
  pendingPermissions: [],
  listening: false,

  ensureListeners: async () => {
    if (get().listening) return;
    set({ listening: true });

    const u1 = await listen<AcpUpdateEvent>("xterax:acp-update", (e) => {
      const { sessionId, update } = e.payload;
      const kind = update.sessionUpdate;

      if (kind === "config_option_update") {
        const opts = parseConfigOptions(
          (update as { configOptions?: unknown }).configOptions,
        );
        if (opts) {
          set((s) => ({
            bindings: patchBindingsByAcpSession(s.bindings, sessionId, {
              configOptions: opts,
            }),
          }));
        }
        return;
      }

      if (kind === "current_mode_update") {
        const u = update as {
          modeId?: string;
          currentModeId?: string;
        };
        const modeId = u.modeId ?? u.currentModeId;
        if (modeId) {
          set((s) => {
            const next = { ...s.bindings };
            for (const [k, b] of Object.entries(next)) {
              if (b.acpSessionId !== sessionId) continue;
              const modes = b.modes
                ? { ...b.modes, currentModeId: modeId }
                : null;
              let configOptions = b.configOptions;
              if (configOptions) {
                configOptions = configOptions.map((opt) => {
                  if (
                    opt.category === "mode" ||
                    opt.id === "mode" ||
                    opt.id.toLowerCase().includes("mode")
                  ) {
                    return { ...opt, currentValue: modeId };
                  }
                  return opt;
                });
              }
              next[k] = { ...b, modes, configOptions };
            }
            return { bindings: next };
          });
        }
        return;
      }

      set((s) => {
        const prev = s.transcripts[sessionId] ?? [];
        return {
          transcripts: {
            ...s.transcripts,
            [sessionId]: applyAcpUpdate(prev, update),
          },
        };
      });

      if (
        kind === "agent_message_chunk" ||
        kind === "tool_call" ||
        kind === "agent_thought_chunk"
      ) {
        set((s) => ({
          bindings: patchBindingsByAcpSession(s.bindings, sessionId, {
            busy: true,
            error: null,
          }),
        }));
      }
    });

    const u2 = await listen<AcpPermissionRequest>(
      "xterax:acp-permission",
      (e) => {
        set((s) => ({
          pendingPermissions: [...s.pendingPermissions, e.payload],
        }));
      },
    );

    const u3 = await listen<{
      connectionId: string;
      agentId: string;
      kind: string;
      message?: string | null;
    }>("xterax:acp-status", (e) => {
      if (e.payload.kind === "exited" || e.payload.kind === "error") {
        set((s) => {
          const next = { ...s.bindings };
          for (const [k, b] of Object.entries(next)) {
            if (b.connectionId === e.payload.connectionId) {
              next[k] = {
                ...b,
                busy: false,
                error: e.payload.message ?? e.payload.kind,
              };
            }
          }
          return { bindings: next };
        });
      }
    });

    unlisteners = [u1, u2, u3];
  },

  connectAgent: async (config) => {
    await get().ensureListeners();
    const status = await acpConnect(config);
    set((s) => {
      const others = s.connections.filter((c) => c.agentId !== config.id);
      return { connections: [...others, status] };
    });
    return status;
  },

  disconnect: async (connectionId) => {
    await acpDisconnect(connectionId);
    set((s) => ({
      connections: s.connections.filter((c) => c.connectionId !== connectionId),
      bindings: Object.fromEntries(
        Object.entries(s.bindings).filter(
          ([, b]) => b.connectionId !== connectionId,
        ),
      ),
    }));
  },

  ensureSession: async ({ chatSessionId, config, cwd, mcpServers }) => {
    await get().ensureListeners();
    const existing = get().bindings[chatSessionId];
    if (existing && existing.agentId === config.id && !existing.error) {
      return existing;
    }

    let conn = get().connections.find(
      (c) => c.agentId === config.id && c.connected,
    );
    if (!conn) {
      conn = await get().connectAgent(config);
    }
    if (!conn.connected || conn.error) {
      throw new Error(conn.error ?? "failed to connect ACP agent");
    }

    const session = await acpSessionNew(
      conn.connectionId,
      cwd,
      mcpServers ? mcpToAcp(mcpServers) : undefined,
    );

    // Prefer top-level `models` (Claude ACP / Zed) over configOptions-only parsing.
    const merged = mergeSessionConfig(
      session.configOptions,
      session.modes,
      session.models,
    );

    const binding: AcpSessionBinding = {
      chatSessionId,
      agentId: config.id,
      connectionId: session.connectionId,
      acpSessionId: session.sessionId,
      busy: false,
      error: null,
      configOptions: merged.configOptions,
      modes: merged.modes,
    };

    set((s) => ({
      bindings: { ...s.bindings, [chatSessionId]: binding },
      transcripts: {
        ...s.transcripts,
        [session.sessionId]: s.transcripts[session.sessionId] ?? [],
      },
    }));
    return binding;
  },

  sendPrompt: async (chatSessionId, text) => {
    const binding = get().bindings[chatSessionId];
    if (!binding) throw new Error("no ACP session for this chat");

    const acpSessionId = binding.acpSessionId;
    set((s) => ({
      transcripts: {
        ...s.transcripts,
        [acpSessionId]: appendUserText(s.transcripts[acpSessionId] ?? [], text),
      },
      bindings: {
        ...s.bindings,
        [chatSessionId]: { ...binding, busy: true, error: null },
      },
    }));

    try {
      await acpPrompt(binding.connectionId, binding.acpSessionId, [
        { type: "text", text },
      ]);
      set((s) => {
        const b = s.bindings[chatSessionId];
        if (!b) return s;
        return {
          bindings: {
            ...s.bindings,
            [chatSessionId]: { ...b, busy: false },
          },
        };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => {
        const b = s.bindings[chatSessionId];
        if (!b) return s;
        return {
          bindings: {
            ...s.bindings,
            [chatSessionId]: { ...b, busy: false, error: msg },
          },
        };
      });
      throw e;
    }
  },

  cancel: async (chatSessionId) => {
    const binding = get().bindings[chatSessionId];
    if (!binding) return;
    const pending = get().pendingPermissions.filter(
      (p) => p.connectionId === binding.connectionId,
    );
    for (const p of pending) {
      try {
        await acpRespondPermission(p.connectionId, p.requestId, "cancelled");
      } catch {
        /* ignore */
      }
    }
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter(
        (p) => p.connectionId !== binding.connectionId,
      ),
    }));
    await acpCancel(binding.connectionId, binding.acpSessionId);
    set((s) => {
      const b = s.bindings[chatSessionId];
      if (!b) return s;
      return {
        bindings: {
          ...s.bindings,
          [chatSessionId]: { ...b, busy: false },
        },
      };
    });
  },

  respondPermission: async (connectionId, requestId, outcome, optionId) => {
    await acpRespondPermission(connectionId, requestId, outcome, optionId);
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter(
        (p) => !(p.connectionId === connectionId && p.requestId === requestId),
      ),
    }));
  },

  setMode: async (chatSessionId, modeId) => {
    const binding = get().bindings[chatSessionId];
    if (!binding) throw new Error("no ACP session");
    await acpSetMode(binding.connectionId, binding.acpSessionId, modeId);
    set((s) => {
      const b = s.bindings[chatSessionId];
      if (!b) return s;
      const modes = b.modes ? { ...b.modes, currentModeId: modeId } : b.modes;
      let configOptions = b.configOptions;
      if (configOptions) {
        configOptions = configOptions.map((opt) =>
          opt.category === "mode" || opt.id === "mode"
            ? { ...opt, currentValue: modeId }
            : opt,
        );
      }
      return {
        bindings: {
          ...s.bindings,
          [chatSessionId]: { ...b, modes, configOptions },
        },
      };
    });
  },

  setConfigOption: async (chatSessionId, configId, value) => {
    const binding = get().bindings[chatSessionId];
    if (!binding) throw new Error("no ACP session");
    const result = await acpSetConfigOption(
      binding.connectionId,
      binding.acpSessionId,
      configId,
      value,
    );
    const opts = parseConfigOptions(result?.configOptions);
    set((s) => {
      const b = s.bindings[chatSessionId];
      if (!b) return s;
      if (opts) {
        // Keep modes; replace config options with agent response (full state).
        return {
          bindings: {
            ...s.bindings,
            [chatSessionId]: { ...b, configOptions: opts },
          },
        };
      }
      // Optimistic local update if agent omitted full list
      const configOptions = (b.configOptions ?? []).map((opt) =>
        opt.id === configId ? { ...opt, currentValue: value } : opt,
      );
      return {
        bindings: {
          ...s.bindings,
          [chatSessionId]: { ...b, configOptions },
        },
      };
    });
  },

  getTranscript: (chatSessionId) => {
    const b = get().bindings[chatSessionId];
    if (!b) return [];
    return get().transcripts[b.acpSessionId] ?? [];
  },

  getBinding: (chatSessionId) => get().bindings[chatSessionId],

  clearBinding: (chatSessionId) => {
    set((s) => {
      const next = { ...s.bindings };
      delete next[chatSessionId];
      return { bindings: next };
    });
  },
}));

/** For tests / HMR cleanup. */
export function stopAcpListeners(): void {
  for (const u of unlisteners) u();
  unlisteners = [];
  useAcpStore.setState({ listening: false });
}
