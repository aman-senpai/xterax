/** Unique identifier for an MCP server — UUID v4 or random 8-char hex. */
export type McpServerId = string;

/**
 * Persisted configuration for a single MCP server.
 *
 * Stored in the preferences store under `mcpServers`. The Rust backend
 * reads this on startup and manages the actual process lifecycle.
 */
export type McpServerConfig = {
  /** Stable unique id (crypto.randomUUID().slice(0, 8)). */
  id: McpServerId;
  /** Display name shown in the settings UI. */
  name: string;
  /** Executable or command — e.g. "npx", "node", "/usr/local/bin/my-server". */
  command: string;
  /** Arguments passed to the command. */
  args: string[];
  /** Environment variables injected into the server process. */
  env: Record<string, string>;
  /** Whether the server should be auto-launched on app start. */
  enabled: boolean;
};

export function newMcpServerId(): McpServerId {
  return crypto.randomUUID().slice(0, 8);
}

export function blankMcpServer(overrides?: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: newMcpServerId(),
    name: "",
    command: "",
    args: [],
    env: {},
    enabled: true,
    ...overrides,
  };
}
