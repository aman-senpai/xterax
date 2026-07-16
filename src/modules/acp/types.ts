/** Unique id for a configured ACP agent. */
export type AcpAgentId = string;

/**
 * Persisted configuration for an external ACP agent process.
 * Stored under preferences `acpAgents`.
 */
export type AcpAgentConfig = {
  id: AcpAgentId;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
  cwd?: string | null;
};

export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};

export type AcpConnectionStatus = {
  connectionId: string;
  agentId: string;
  name: string;
  connected: boolean;
  protocolVersion: number | null;
  agentInfo: unknown | null;
  agentCapabilities: unknown | null;
  error: string | null;
};

export type AcpConfigOptionValue = {
  value: string;
  name: string;
  description?: string;
};

export type AcpConfigOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select" | "boolean" | string;
  currentValue: string | boolean;
  options?: AcpConfigOptionValue[];
};

export type AcpModeState = {
  currentModeId: string;
  availableModes: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
};

export type AcpSessionResult = {
  connectionId: string;
  sessionId: string;
  modes?: AcpModeState | null;
  configOptions?: AcpConfigOption[] | null;
  /** Top-level models payload from Claude ACP (same source Zed uses). */
  models?: unknown;
};

export type AcpPromptResult = {
  stopReason: string;
};

export type AcpPermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
};

export type AcpPermissionRequest = {
  connectionId: string;
  requestId: number;
  sessionId: string;
  toolCall: unknown;
  options: AcpPermissionOption[];
};

export type AcpUpdateEvent = {
  connectionId: string;
  sessionId: string;
  update: AcpSessionUpdate;
};

export type AcpSessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      messageId?: string;
      content: { type: string; text?: string; [k: string]: unknown };
    }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: string;
      content?: unknown;
      locations?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: string;
      status?: string;
      content?: unknown;
      locations?: unknown;
      rawInput?: unknown;
      rawOutput?: unknown;
    }
  | {
      sessionUpdate: "plan";
      entries: Array<{
        content: string;
        priority?: string;
        status?: string;
      }>;
    }
  | {
      sessionUpdate: "available_commands_update";
      availableCommands: unknown[];
    }
  | {
      sessionUpdate: "current_mode_update";
      /** Spec uses modeId; some agents send currentModeId. */
      modeId?: string;
      currentModeId?: string;
    }
  | {
      sessionUpdate: "config_option_update";
      configOptions: AcpConfigOption[];
    }
  | {
      sessionUpdate: "usage_update";
      used: number;
      size: number;
      cost?: { amount: number; currency: string };
    }
  | {
      sessionUpdate: string;
      [k: string]: unknown;
    };

export type AcpTranscriptMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: AcpMessagePart[];
  createdAt: number;
};

export type AcpMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      title: string;
      kind: string;
      status: string;
      content?: unknown;
    }
  | {
      type: "plan";
      entries: Array<{ content: string; priority?: string; status?: string }>;
    };

export function newAcpAgentId(): AcpAgentId {
  return crypto.randomUUID().slice(0, 8);
}

export function blankAcpAgent(
  overrides?: Partial<AcpAgentConfig>,
): AcpAgentConfig {
  return {
    id: newAcpAgentId(),
    name: "",
    command: "",
    args: [],
    env: {},
    enabled: true,
    cwd: null,
    ...overrides,
  };
}
