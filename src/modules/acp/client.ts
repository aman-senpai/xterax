import { invoke } from "@tauri-apps/api/core";
import type {
  AcpAgentConfig,
  AcpConnectionStatus,
  AcpMcpServer,
  AcpPromptResult,
  AcpSessionResult,
} from "./types";

export async function acpConnect(
  config: AcpAgentConfig,
): Promise<AcpConnectionStatus> {
  return invoke<AcpConnectionStatus>("acp_connect", { config });
}

export async function acpDisconnect(connectionId: string): Promise<void> {
  await invoke("acp_disconnect", { connectionId });
}

export async function acpListConnections(): Promise<AcpConnectionStatus[]> {
  return invoke<AcpConnectionStatus[]>("acp_list_connections");
}

export async function acpSessionNew(
  connectionId: string,
  cwd: string,
  mcpServers?: AcpMcpServer[],
): Promise<AcpSessionResult> {
  return invoke<AcpSessionResult>("acp_session_new", {
    connectionId,
    cwd,
    mcpServers: mcpServers ?? null,
  });
}

export async function acpPrompt(
  connectionId: string,
  sessionId: string,
  prompt: Array<{ type: string; text?: string; [k: string]: unknown }>,
): Promise<AcpPromptResult> {
  return invoke<AcpPromptResult>("acp_prompt", {
    connectionId,
    sessionId,
    prompt,
  });
}

export async function acpCancel(
  connectionId: string,
  sessionId: string,
): Promise<void> {
  await invoke("acp_cancel", { connectionId, sessionId });
}

export async function acpRespondPermission(
  connectionId: string,
  requestId: number,
  outcome: "selected" | "cancelled",
  optionId?: string | null,
): Promise<void> {
  await invoke("acp_respond_permission", {
    connectionId,
    response: {
      requestId,
      outcome,
      optionId: optionId ?? null,
    },
  });
}

export async function acpSetMode(
  connectionId: string,
  sessionId: string,
  modeId: string,
): Promise<unknown> {
  return invoke("acp_set_mode", { connectionId, sessionId, modeId });
}

export async function acpSetConfigOption(
  connectionId: string,
  sessionId: string,
  configId: string,
  value: string | boolean,
): Promise<{ configOptions?: import("./types").AcpConfigOption[] }> {
  return invoke("acp_set_config_option", {
    connectionId,
    sessionId,
    configId,
    value,
  });
}
