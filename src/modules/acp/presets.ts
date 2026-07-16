import { blankAcpAgent, type AcpAgentConfig } from "./types";

/**
 * Built-in ACP agent presets. Args follow public docs / common adapters;
 * users can edit after adding. Detection of installed binaries is best-effort
 * (PATH only) — never required for the app to start.
 */
export type AcpPreset = {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
};

export const ACP_PRESETS: AcpPreset[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description:
      "Anthropic Claude Code via ACP (same adapter Zed uses). Prefer a global install: npm i -g @zed-industries/claude-agent-acp",
    // Prefer the on-PATH binary (matches Zed). Fall back to npx in Settings if needed.
    command: "claude-agent-acp",
    args: [],
  },
  {
    id: "codex",
    name: "Codex",
    description: "OpenAI Codex CLI via ACP adapter",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    description: "Google Gemini CLI ACP mode",
    command: "gemini",
    args: ["--experimental-acp"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    description: "OpenCode ACP server",
    command: "opencode",
    args: ["acp"],
  },
];

export function presetToConfig(preset: AcpPreset): AcpAgentConfig {
  return blankAcpAgent({
    name: preset.name,
    command: preset.command,
    args: [...preset.args],
    enabled: true,
  });
}
