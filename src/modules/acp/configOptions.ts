import type { AcpConfigOption, AcpConfigOptionValue, AcpModeState } from "./types";

/** Normalize agent-advertised modes (accept camelCase or snake_case). */
export function parseModes(raw: unknown): AcpModeState | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const available = Array.isArray(o.availableModes)
    ? o.availableModes
    : Array.isArray(o.available_modes)
      ? o.available_modes
      : null;
  if (!available || available.length === 0) return null;

  const availableModes = available
    .map((m) => {
      if (!m || typeof m !== "object") return null;
      const mm = m as Record<string, unknown>;
      const id =
        typeof mm.id === "string"
          ? mm.id
          : typeof mm.modeId === "string"
            ? mm.modeId
            : null;
      const name =
        typeof mm.name === "string"
          ? mm.name
          : typeof mm.title === "string"
            ? mm.title
            : id;
      if (!id || !name) return null;
      return {
        id,
        name,
        description:
          typeof mm.description === "string" ? mm.description : undefined,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m != null);

  if (availableModes.length === 0) return null;

  const currentModeId =
    (typeof o.currentModeId === "string" && o.currentModeId) ||
    (typeof o.current_mode_id === "string" && o.current_mode_id) ||
    availableModes[0].id;

  return { currentModeId, availableModes };
}

/**
 * Flatten select option leaves. Agents (and claude-agent-acp's set handler)
 * may nest groups: `{ name, options: [...] }` with no `value` on the group.
 */
export function flattenSelectOptions(
  options: unknown[] | undefined,
): AcpConfigOptionValue[] {
  if (!Array.isArray(options) || options.length === 0) return [];
  const out: AcpConfigOptionValue[] = [];
  const seen = new Set<string>();

  const walk = (items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      // Nested group (no leaf value)
      if (Array.isArray(o.options) && o.value === undefined && o.id === undefined) {
        walk(o.options);
        continue;
      }
      // Leaf: value | modelId | id
      const value =
        typeof o.value === "string"
          ? o.value
          : typeof o.modelId === "string"
            ? o.modelId
            : typeof o.model_id === "string"
              ? o.model_id
              : typeof o.id === "string"
                ? o.id
                : null;
      if (!value || seen.has(value)) continue;
      const name =
        typeof o.name === "string"
          ? o.name
          : typeof o.displayName === "string"
            ? o.displayName
            : typeof o.display_name === "string"
              ? o.display_name
              : typeof o.label === "string"
                ? o.label
                : typeof o.title === "string"
                  ? o.title
                  : value;
      seen.add(value);
      out.push({
        value,
        name,
        description:
          typeof o.description === "string" ? o.description : undefined,
      });
    }
  };

  walk(options);
  return out;
}

/**
 * Session/new may return a top-level `models` object (Claude ACP / Zed):
 * `{ currentModelId, availableModels: [{ modelId, name, description }] }`
 */
export function parseSessionModels(raw: unknown): AcpConfigOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const available = Array.isArray(o.availableModels)
    ? o.availableModels
    : Array.isArray(o.available_models)
      ? o.available_models
      : null;
  if (!available || available.length === 0) return null;

  const options = flattenSelectOptions(available);
  if (options.length === 0) return null;

  const currentModelId =
    (typeof o.currentModelId === "string" && o.currentModelId) ||
    (typeof o.current_model_id === "string" && o.current_model_id) ||
    options[0].value;

  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModelId,
    options,
  };
}

/** Normalize agent-advertised session config options. */
export function parseConfigOptions(raw: unknown): AcpConfigOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: AcpConfigOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : null;
    if (!id) continue;
    const name =
      typeof o.name === "string"
        ? o.name
        : typeof o.title === "string"
          ? o.title
          : id;
    const type =
      typeof o.type === "string"
        ? o.type
        : Array.isArray(o.options)
          ? "select"
          : typeof o.currentValue === "boolean" ||
              typeof o.current_value === "boolean"
            ? "boolean"
            : "select";
    const currentValue =
      o.currentValue !== undefined
        ? (o.currentValue as string | boolean)
        : o.current_value !== undefined
          ? (o.current_value as string | boolean)
          : type === "boolean"
            ? false
            : "";

    const options =
      type === "boolean"
        ? undefined
        : flattenSelectOptions(
            Array.isArray(o.options) ? o.options : undefined,
          );

    // Infer category from id/name when agent omits it
    let category =
      typeof o.category === "string" ? o.category : undefined;
    if (!category) {
      const key = `${id} ${name}`.toLowerCase();
      if (key.includes("mode") || key.includes("permission"))
        category = "mode";
      else if (key.includes("model") || key.includes("llm"))
        category = "model";
      else if (
        key.includes("thought") ||
        key.includes("thinking") ||
        key.includes("reason") ||
        key.includes("effort")
      )
        category = "thought_level";
    }

    out.push({
      id,
      name,
      description:
        typeof o.description === "string" ? o.description : undefined,
      category,
      type,
      currentValue,
      options: options && options.length > 0 ? options : undefined,
    });
  }
  return out.length ? out : null;
}

/**
 * Merge session/new payload into config options.
 * Prefer top-level `models` for the model slot when present (matches Zed).
 */
export function mergeSessionConfig(
  configOptions: unknown,
  modes: unknown,
  models: unknown,
): { configOptions: AcpConfigOption[] | null; modes: AcpModeState | null } {
  const parsedModes = parseModes(modes);
  let parsedOpts = parseConfigOptions(configOptions);
  const modelFromSession = parseSessionModels(models);

  if (modelFromSession) {
    if (!parsedOpts) {
      parsedOpts = [modelFromSession];
    } else {
      const withoutModel = parsedOpts.filter(
        (o) => o.category !== "model" && o.id !== "model",
      );
      // Keep agent order: mode first if present, then model, then rest
      const modeOpt = withoutModel.find(
        (o) => o.category === "mode" || o.id === "mode",
      );
      const rest = withoutModel.filter((o) => o !== modeOpt);
      parsedOpts = [
        ...(modeOpt ? [modeOpt] : []),
        modelFromSession,
        ...rest,
      ];
    }
  }

  // If we have legacy modes but no mode config option, leave modes for slotConfigOptions
  return { configOptions: parsedOpts, modes: parsedModes };
}

/** Map legacy modes into a synthetic config option for one UI path. */
export function modesAsConfigOption(modes: AcpModeState): AcpConfigOption {
  return {
    id: "__legacy_mode__",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })),
  };
}

export type AcpControlSlots = {
  mode: AcpConfigOption | null;
  thought: AcpConfigOption | null;
  model: AcpConfigOption | null;
  extra: AcpConfigOption[];
  /**
   * True when `thought` is derived from model-id bracket params
   * (Claude ACP has no separate thought_level config option).
   */
  thoughtFromModel: boolean;
};

/** Prefer category match, then id heuristics, keep agent order for extras. */
export function slotConfigOptions(
  options: AcpConfigOption[] | null,
  modes: AcpModeState | null,
): AcpControlSlots {
  const list = options ? [...options] : [];
  const used = new Set<string>();

  const take = (
    pred: (o: AcpConfigOption) => boolean,
  ): AcpConfigOption | null => {
    const found = list.find((o) => !used.has(o.id) && pred(o));
    if (found) used.add(found.id);
    return found ?? null;
  };

  let mode =
    take((o) => o.category === "mode") ??
    take((o) => o.id === "mode" || /^mode$/i.test(o.id));
  let thought =
    take((o) => o.category === "thought_level") ??
    take(
      (o) =>
        /thought|thinking|reason|effort/i.test(o.id) ||
        /thought|thinking|reason/i.test(o.name),
    );
  const model =
    take((o) => o.category === "model") ??
    take((o) => o.id === "model" || /^model$/i.test(o.id));

  if (!mode && modes) {
    mode = modesAsConfigOption(modes);
  }

  // Claude ACP only ships mode + model. Thinking is encoded in model ids:
  //   claude-sonnet-4-6[thinking=true,effort=medium]
  //   gpt-5.4[reasoning=medium]
  // Derive a brain-control from the current model when the agent omits
  // a dedicated thought_level option (same UX users expect from local agents).
  let thoughtFromModel = false;
  if (!thought && model) {
    const derived = deriveThoughtOptionFromModel(model);
    if (derived) {
      thought = derived;
      thoughtFromModel = true;
    }
  }

  const extra = list.filter((o) => !used.has(o.id));
  return { mode, thought, model, extra, thoughtFromModel };
}

// ---------------------------------------------------------------------------
// Model-id bracket thinking (Claude / OpenAI-style ACP models)
// ---------------------------------------------------------------------------

export type ThoughtLevel = "off" | "low" | "medium" | "high" | "max";

const THOUGHT_LEVELS: readonly {
  value: ThoughtLevel;
  label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

/** Synthetic config id — not sent to the agent; rewritten onto model. */
export const MODEL_THOUGHT_OPTION_ID = "__model_thought__";

export function splitModelId(modelId: string): {
  base: string;
  params: Record<string, string>;
  /** Bare tokens in brackets without `=` (e.g. `1m` in `opus[1m]`). */
  bare: string[];
} {
  const open = modelId.indexOf("[");
  const close = modelId.lastIndexOf("]");
  if (open < 0 || close <= open) {
    return { base: modelId, params: {}, bare: [] };
  }
  const base = modelId.slice(0, open);
  const raw = modelId.slice(open + 1, close);
  const params: Record<string, string> = {};
  const bare: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      bare.push(trimmed);
      continue;
    }
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) params[k] = v;
  }
  return { base, params, bare };
}

export function joinModelId(
  base: string,
  params: Record<string, string>,
  bare: string[] = [],
): string {
  const keys = Object.keys(params).filter((k) => params[k] !== "");
  const order = ["thinking", "reasoning", "effort", "context", "fast"];
  keys.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) {
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }
    return a.localeCompare(b);
  });
  const parts = [
    ...bare,
    ...keys.map((k) => `${k}=${params[k]}`),
  ];
  if (parts.length === 0) return base;
  return `${base}[${parts.join(",")}]`;
}

function modelIdHasThoughtParams(modelId: string): boolean {
  const { params } = splitModelId(modelId);
  return (
    "thinking" in params ||
    "effort" in params ||
    "reasoning" in params ||
    "reasoning_effort" in params
  );
}

/** Read thought level from a model id's bracket params. */
export function thoughtLevelFromModelId(modelId: string): ThoughtLevel | null {
  if (!modelIdHasThoughtParams(modelId)) return null;
  const { params } = splitModelId(modelId);
  if (params.thinking === "false" || params.thinking === "0") return "off";
  const effort = (
    params.effort ||
    params.reasoning ||
    params.reasoning_effort ||
    ""
  ).toLowerCase();
  if (effort === "off" || effort === "none" || effort === "disabled")
    return "off";
  if (effort === "low" || effort === "minimal") return "low";
  if (effort === "medium" || effort === "mid") return "medium";
  if (effort === "high") return "high";
  if (effort === "max" || effort === "maximum" || effort === "xhigh")
    return "max";
  // thinking=true without effort → treat as medium
  if (params.thinking === "true" || params.thinking === "1") return "medium";
  return "medium";
}

/**
 * Write a thought level into a model id.
 * Preserves unrelated params (context, fast, …).
 */
export function applyThoughtToModelId(
  modelId: string,
  level: ThoughtLevel,
): string {
  const { base, params, bare } = splitModelId(modelId);
  const next = { ...params };

  const usesReasoning =
    "reasoning" in params ||
    "reasoning_effort" in params ||
    (!("thinking" in params) &&
      !("effort" in params) &&
      /gpt|o[0-9]|codex/i.test(base));

  if (usesReasoning) {
    delete next.thinking;
    delete next.effort;
    if (level === "off") {
      delete next.reasoning;
      delete next.reasoning_effort;
    } else {
      next.reasoning = level === "max" ? "high" : level;
      delete next.reasoning_effort;
    }
  } else {
    // Claude-style: thinking + optional effort
    if (level === "off") {
      // Drop thinking flags entirely when turning off so clean ids stay clean
      // (e.g. deepseek-v4-pro[1m] stays deepseek-v4-pro[1m], not …[thinking=false]).
      delete next.thinking;
      delete next.effort;
    } else {
      next.thinking = "true";
      next.effort = level === "max" ? "high" : level;
    }
  }

  return joinModelId(base, next, bare);
}

/**
 * Build a synthetic thought_level option from the model config option when
 * the agent does not advertise one (Claude ACP only sends mode + model).
 *
 * Always returns a control when a model is selected so the brain button is
 * clickable. Levels are applied by rewriting model-id brackets
 * (`thinking` / `effort` / `reasoning`), which is how Claude ACP encodes
 * thinking — there is no separate thought_level config option.
 */
export function deriveThoughtOptionFromModel(
  model: AcpConfigOption,
): AcpConfigOption | null {
  const current =
    typeof model.currentValue === "string" ? model.currentValue : "";
  if (!current && !(model.options && model.options.length > 0)) {
    return null;
  }

  let currentLevel: ThoughtLevel = "off";
  if (current && modelIdHasThoughtParams(current)) {
    currentLevel = thoughtLevelFromModelId(current) ?? "off";
  }

  return {
    id: MODEL_THOUGHT_OPTION_ID,
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: currentLevel,
    options: THOUGHT_LEVELS.map((l) => ({
      value: l.value,
      name: l.label,
    })),
  };
}

/**
 * Apply a synthetic thought change onto the model config option's value.
 * Returns the new model id to send via session/set_config_option.
 */
export function modelIdAfterThoughtChange(
  model: AcpConfigOption,
  level: ThoughtLevel,
): string | null {
  const current =
    typeof model.currentValue === "string" ? model.currentValue : null;
  if (!current) return null;

  if (modelIdHasThoughtParams(current)) {
    return applyThoughtToModelId(current, level);
  }

  // Current model has no thought params — try to find a sibling with same base
  // that does, then rewrite; otherwise attach brackets to the current id.
  const { base } = splitModelId(current);
  const sibling = (model.options ?? []).find(
    (o) =>
      splitModelId(o.value).base === base && modelIdHasThoughtParams(o.value),
  );
  if (sibling) {
    return applyThoughtToModelId(sibling.value, level);
  }
  // Attach params even if none existed (agent may accept them)
  return applyThoughtToModelId(current, level);
}

/** Short label for toolbar chip — prefer human name, not raw model id. */
export function optionCurrentLabel(option: AcpConfigOption): string {
  if (option.type === "boolean") {
    return option.currentValue === true ? "On" : "Off";
  }
  const values = option.options ?? [];
  const cur = findMatchingOption(values, option.currentValue);
  if (cur) return cur.name;
  if (typeof option.currentValue === "string" && option.currentValue) {
    return shortModelLabel(option.currentValue);
  }
  return option.name;
}

/** Match currentValue to an option leaf (exact, then fuzzy alias). */
export function findMatchingOption(
  options: AcpConfigOptionValue[],
  current: string | boolean | undefined,
): AcpConfigOptionValue | undefined {
  if (current === undefined || current === null) return undefined;
  if (typeof current === "boolean") return undefined;
  const exact = options.find((v) => v.value === current);
  if (exact) return exact;
  const lower = current.toLowerCase();
  const byName = options.find(
    (v) =>
      v.name.toLowerCase() === lower ||
      v.value.toLowerCase() === lower,
  );
  if (byName) return byName;
  // Alias match: "haiku" → "claude-haiku-4-5[...]"
  const tokens = lower
    .replace(/\[.*?\]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t !== "claude" && t !== "default" && t !== "best");
  if (tokens.length === 0) return undefined;
  let best: AcpConfigOptionValue | undefined;
  let bestScore = 0;
  for (const opt of options) {
    const hay = `${opt.value} ${opt.name}`.toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (hay.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return bestScore > 0 ? best : undefined;
}

export function shortModelLabel(raw: string): string {
  // "claude-sonnet-4-6[thinking=true,context=200k]" → "claude-sonnet-4-6"
  const bracket = raw.indexOf("[");
  if (bracket > 0) return raw.slice(0, bracket);
  if (raw.length > 32) return `${raw.slice(0, 28)}…`;
  return raw;
}

/** Whether this option value is the current selection. */
export function isOptionSelected(
  option: AcpConfigOption,
  value: string,
): boolean {
  if (option.currentValue === value) return true;
  if (typeof option.currentValue !== "string") return false;
  const match = findMatchingOption(option.options ?? [], option.currentValue);
  return match?.value === value;
}
