import { invoke } from "@tauri-apps/api/core";
import type { McpServerConfig } from "./types";

// ---------------------------------------------------------------------------
// Types mirrored from Rust
// ---------------------------------------------------------------------------

export type McpToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type McpToolResult = {
  content: McpContent[];
  is_error: boolean;
};

export type McpContent = {
  type: string;
  text?: string;
  data?: string;
  mime_type?: string;
};

export type McpServerStatus = {
  id: string;
  name: string;
  connected: boolean;
  tool_count: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

export async function mcpSyncServers(
  configs: McpServerConfig[],
): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("mcp_sync_servers", { configs });
}

export async function mcpConnect(
  config: McpServerConfig,
): Promise<void> {
  await invoke("mcp_connect", { config });
}

export async function mcpDisconnect(serverId: string): Promise<void> {
  await invoke("mcp_disconnect", { serverId });
}

export async function mcpListTools(
  serverId: string,
): Promise<McpToolDef[]> {
  return invoke<McpToolDef[]>("mcp_list_tools", { serverId });
}

export async function mcpCallTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  return invoke<McpToolResult>("mcp_call_tool", {
    serverId,
    toolName,
    args,
  });
}

export async function mcpGetStatus(): Promise<McpServerStatus[]> {
  return invoke<McpServerStatus[]>("mcp_get_status");
}
