import { useEffect, useState } from "react";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import { mcpSyncServers, mcpListTools } from "@/modules/mcp/client";
import { cacheMcpTools, clearMcpToolCache } from "@/modules/mcp/tools";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import {
  getAllCustomEndpointKeys,
  getAllKeys,
  hasAnyKey,
} from "../lib/keyring";
import { applyOverrides } from "../lib/prompts";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

// Module-level selectors — stable references for Zustand v5.
const selectApiKeys = (s: ReturnType<typeof useChatStore.getState>) =>
  s.apiKeys;
const selectCustomEndpoints = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.customEndpoints;
const selectPromptOverrides = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.promptOverrides;
const selectMcpServers = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.mcpServers;

/**
 * Startup wiring for the AI subsystem: loads provider keys (and keeps them in
 * sync), hydrates the preference store and mirrors the default model, hydrates
 * chat/agents/snippets stores, and fires any pending review for the active
 * session. Returns the two derived flags the shell needs.
 */
export function useAiBootstrap(): {
  hasComposer: boolean;
  keysLoaded: boolean;
} {
  const apiKeys = useChatStore(selectApiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setCustomEndpointKeys = useChatStore((s) => s.setCustomEndpointKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setThinkingLevel = useChatStore((s) => s.setThinkingLevel);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);

  useEffect(() => {
    if (activeSessionId) firePendingReviewForSession(activeSessionId);
  }, [activeSessionId]);

  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const customEndpoints = usePreferencesStore(selectCustomEndpoints);
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (ollamaBaseURL.trim().length > 0 && ollamaModelId.trim().length > 0) ||
    (openaiCompatibleBaseURL.trim().length > 0 &&
      openaiCompatibleModelId.trim().length > 0) ||
    customEndpoints.some(
      (e) => e.baseURL.trim().length > 0 && e.modelId.trim().length > 0,
    );
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel;

  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
      if (!prefsHydrated) return;
      void getAllCustomEndpointKeys(
        usePreferencesStore.getState().customEndpoints,
      ).then((epKeys) => {
        if (!alive) return;
        setCustomEndpointKeys(epKeys);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys, setCustomEndpointKeys, prefsHydrated]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  const prefDefaultThinkingLevel = usePreferencesStore(
    (s) => s.defaultThinkingLevel,
  );
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModelId(prefDefaultModel);
  }, [prefsHydrated, prefDefaultModel, setSelectedModelId]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setThinkingLevel(prefDefaultThinkingLevel);
  }, [prefsHydrated, prefDefaultThinkingLevel, setThinkingLevel]);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
    void import("../store/modesStore").then(({ useModesStore }) => {
      void useModesStore.getState().hydrate();
    });
  }, [hydrateSessions]);

  // Sync prompt overrides from settings → prompts module.
  const promptOverrides = usePreferencesStore(selectPromptOverrides);
  useEffect(() => {
    if (!prefsHydrated) return;
    if (Object.keys(promptOverrides).length > 0) {
      applyOverrides(promptOverrides);
    }
  }, [prefsHydrated, promptOverrides]);

  // Sync MCP servers: start/stop processes and cache discovered tools.
  const mcpServers = usePreferencesStore(selectMcpServers);
  useEffect(() => {
    if (!prefsHydrated) return;
    let cancelled = false;
    void (async () => {
      console.log(
        `[MCP] Syncing ${mcpServers.filter((s) => s.enabled).length} enabled / ${mcpServers.length} total servers…`,
      );
      let statuses: Awaited<ReturnType<typeof mcpSyncServers>>;
      try {
        statuses = await mcpSyncServers(mcpServers);
      } catch (e) {
        console.error(
          `[MCP] mcpSyncServers threw: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      if (cancelled) return;
      clearMcpToolCache();
      for (const s of statuses) {
        if (!s.connected) {
          if (s.error) {
            console.warn(
              `[MCP] Server "${s.name}" (${s.id}) failed to connect: ${s.error}`,
            );
          }
          continue;
        }
        console.log(
          `[MCP] Server "${s.name}" (${s.id}) connected with ${s.tool_count} tools`,
        );
        try {
          const tools = await mcpListTools(s.id);
          cacheMcpTools(s.id, s.name, tools);
        } catch (e) {
          console.warn(
            `[MCP] Server "${s.name}" (${s.id}) tools/list failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefsHydrated, mcpServers]);

  return { hasComposer, keysLoaded };
}
