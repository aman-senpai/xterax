import type { SkillConfig } from "@/modules/skills/types";
import { CheckListIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { syncModeFromPlanStore } from "../store/modesStore";
import { usePlanStore } from "../store/planStore";
import { getInitCommandPrompt } from "./prompts";

/**
 * Outcome of intercepting a slash command from the composer.
 *
 * - `"handled"`: command ran; the composer should NOT send a chat message.
 * - `"send-prompt"`: replace the user's text with `prompt` and send normally.
 * - `"none"`: not a slash command; let the composer behave as usual.
 */
export type SlashOutcome =
  | { kind: "handled"; toast?: string }
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

const INIT_PROMPT = getInitCommandPrompt();

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  icon: typeof SparklesIcon;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  init: {
    name: "init",
    invocation: "/init",
    label: "Initialize workspace",
    icon: SparklesIcon,
  },
  plan: {
    name: "plan",
    invocation: "/plan",
    label: "Plan mode",
    icon: CheckListIcon,
  },
};

export const XTERAX_CMD_RE =
  /^<xterax-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

export function wrapWithCommandMarker(prompt: string, name: string): string {
  return `<xterax-command name="${name}" />\n\n${prompt}`;
}

/**
 * Try to match a skill name from the enabled skills configs.
 * Returns the skill if found, null otherwise.
 */
function findSkill(name: string, skills: SkillConfig[]): SkillConfig | null {
  return skills.find((s) => s.enabled && s.name === name) ?? null;
}

export function tryRunSlashCommand(
  input: string,
  skills?: SkillConfig[],
): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };
  const tail = rest.join(" ").trim();

  switch (head) {
    case "plan": {
      const store = usePlanStore.getState();
      if (tail === "off" || tail === "exit") {
        store.disable();
        syncModeFromPlanStore(false);
        return { kind: "handled", toast: "Plan mode off" };
      }
      store.toggle();
      const nowActive = usePlanStore.getState().active;
      syncModeFromPlanStore(nowActive);
      return {
        kind: "handled",
        toast: nowActive ? "Plan mode on" : "Plan mode off",
      };
    }
    case "init": {
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    }
    default: {
      // Check if it matches an enabled skill
      if (skills && lead === "/") {
        const skill = findSkill(head, skills);
        if (skill) {
          const skillPrompt =
            skill.content ??
            `Activate the **${skill.name}** skill: ${skill.description}`;
          return {
            kind: "send-prompt",
            prompt: `<skill-activation name="${skill.name}">\n${skillPrompt}\n</skill-activation>\n\n${tail}`,
            commandName: skill.name,
          };
        }
      }
      return { kind: "none" };
    }
  }
}
