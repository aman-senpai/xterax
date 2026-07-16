/**
 * User-authored pipeline DSL for agent delegation.
 *
 * Examples:
 *
 *   @architect design the API
 *   @coder implement it
 *   @verification
 *
 *   @architect plan the fix
 *   loop 3:
 *     @coder implement
 *     @verification run checks
 *     break if pass
 *   @reviewer final pass
 *
 *   @architect -> @coder -> @verification
 *
 *   loop:
 *     @coder @verification
 *     break if pass
 *
 * Bare `loop:` uses the configured default max (prefs, else 3).
 * `loop 15:` sets max iterations to 15 (clamped to absolute ceiling).
 *
 * Keywords: loop, break, if, pass, fail, done, ok
 * Chaining: -> or whitespace-separated @handles
 */

export type BreakCond = "pass" | "fail" | "done" | "always" | "never";

export type PipelineAstNode =
  | { type: "agent"; handle: string }
  | {
      type: "loop";
      /** Max iterations (default 3). */
      max: number;
      body: PipelineAstNode[];
      /** If set, evaluated after each body run; break when true. */
      breakWhen: BreakCond | null;
    };

export type PipelineProgram = {
  nodes: PipelineAstNode[];
  /** User brief with structure tokens removed. */
  body: string;
  /** Flattened agent handles in source order (for chips / validation). */
  handles: string[];
};

/** Default when bare `loop:` has no number (also prefs default). */
export const DEFAULT_LOOP_MAX = 3;
/** Default absolute ceiling for any loop max (also prefs default). */
export const ABSOLUTE_LOOP_MAX = 8;
/** Product hard cap: prefs absoluteMax cannot exceed this. */
export const SYSTEM_LOOP_MAX = 16;
export const MAX_PIPELINE_NODES = 24;

export type PipelineParseOptions = {
  /** Used for bare `loop:` (no number). Default DEFAULT_LOOP_MAX. */
  defaultMax?: number;
  /** Ceiling for every loop max. Default ABSOLUTE_LOOP_MAX. */
  absoluteMax?: number;
};

/** Saved reusable loop template (Settings → Agents → Pipeline loops). */
export type PipelineLoopPreset = {
  id: string;
  /** Insert with #handle in the composer. */
  handle: string;
  name: string;
  description: string;
  /** Iteration cap written into the expanded DSL. */
  max: number;
  /**
   * Body lines inside the loop (agents + optional break).
   * Example: "@coder implement\n@verification\nbreak if pass"
   */
  body: string;
};

export type PipelineLoopSettings = {
  defaultMax: number;
  absoluteMax: number;
  presets: PipelineLoopPreset[];
};

export const DEFAULT_PIPELINE_LOOP_SETTINGS: PipelineLoopSettings = {
  defaultMax: DEFAULT_LOOP_MAX,
  absoluteMax: ABSOLUTE_LOOP_MAX,
  presets: [
    {
      id: "preset-implement-verify",
      handle: "implement-verify",
      name: "Implement & verify",
      description: "Code, check, stop when green",
      max: 3,
      body: "@coder implement\n@verification run checks\nbreak if pass",
    },
  ],
};

export function clampLoopMax(
  n: number,
  absoluteMax = ABSOLUTE_LOOP_MAX,
): number {
  const abs = Math.min(
    SYSTEM_LOOP_MAX,
    Math.max(
      1,
      Math.floor(
        Number.isFinite(absoluteMax) ? absoluteMax : ABSOLUTE_LOOP_MAX,
      ),
    ),
  );
  const v = Math.floor(Number.isFinite(n) ? n : DEFAULT_LOOP_MAX);
  return Math.min(abs, Math.max(1, v));
}

export function normalizePipelineLoopSettings(
  raw: Partial<PipelineLoopSettings> | null | undefined,
): PipelineLoopSettings {
  const abs = clampLoopMax(
    raw?.absoluteMax ?? ABSOLUTE_LOOP_MAX,
    SYSTEM_LOOP_MAX,
  );
  const def = clampLoopMax(raw?.defaultMax ?? DEFAULT_LOOP_MAX, abs);
  const presets = Array.isArray(raw?.presets)
    ? raw!.presets
        .filter(
          (p): p is PipelineLoopPreset =>
            !!p &&
            typeof p.id === "string" &&
            typeof p.handle === "string" &&
            typeof p.name === "string" &&
            typeof p.body === "string",
        )
        .map((p) => ({
          id: p.id,
          handle: p.handle
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-"),
          name: p.name.trim() || p.handle,
          description: typeof p.description === "string" ? p.description : "",
          max: clampLoopMax(p.max ?? def, abs),
          body: p.body,
        }))
        .filter((p) => p.handle.length > 0)
    : [...DEFAULT_PIPELINE_LOOP_SETTINGS.presets];
  return { defaultMax: def, absoluteMax: abs, presets };
}

/** Expand a saved preset into composer DSL text. */
export function formatLoopPreset(
  preset: PipelineLoopPreset,
  absoluteMax: number = ABSOLUTE_LOOP_MAX,
): string {
  const max = clampLoopMax(preset.max, absoluteMax);
  const body = preset.body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .map((l) => `  ${l.trim()}`)
    .join("\n");
  return body ? `loop ${max}:\n${body}` : `loop ${max}:`;
}

const KEYWORDS = new Set([
  "loop",
  "break",
  "if",
  "pass",
  "fail",
  "done",
  "ok",
  "then",
  "end",
  "endloop",
]);

type Tok =
  | { kind: "at"; handle: string }
  | { kind: "kw"; value: string }
  | { kind: "num"; value: number }
  | { kind: "arrow" }
  | { kind: "colon" }
  | { kind: "nl" }
  | { kind: "text"; value: string };

function tokenize(src: string): Tok[] {
  // Normalize agent chips to bare @handles for parsing.
  const normalized = src
    .replace(/\[agent:([a-z][a-z0-9-]*)\]/gi, "@$1")
    .replace(/\r\n/g, "\n");

  const tokens: Tok[] = [];
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === "\n") {
      tokens.push({ kind: "nl" });
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "-" && normalized[i + 1] === ">") {
      tokens.push({ kind: "arrow" });
      i += 2;
      continue;
    }
    if (ch === ":") {
      tokens.push({ kind: "colon" });
      i++;
      continue;
    }
    if (ch === "@") {
      let j = i + 1;
      while (j < normalized.length && /[a-z0-9-]/i.test(normalized[j])) j++;
      const handle = normalized.slice(i + 1, j).toLowerCase();
      if (handle) tokens.push({ kind: "at", handle });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < normalized.length && /[0-9]/.test(normalized[j])) j++;
      tokens.push({ kind: "num", value: Number(normalized.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-z_]/i.test(ch)) {
      let j = i;
      while (j < normalized.length && /[a-z0-9_]/i.test(normalized[j])) j++;
      const word = normalized.slice(i, j).toLowerCase();
      if (KEYWORDS.has(word)) {
        tokens.push({ kind: "kw", value: word });
      } else {
        // Non-keyword word — treat as body text start; collect until structure.
        let k = j;
        while (k < normalized.length) {
          const c = normalized[k];
          if (
            c === "\n" ||
            c === "@" ||
            (c === "-" && normalized[k + 1] === ">")
          )
            break;
          // Stop before loop/break keywords at word boundary
          if (k > j && /\s/.test(normalized[k - 1])) {
            const rest = normalized
              .slice(k)
              .match(/^(loop|break|endloop|end)\b/i);
            if (rest) break;
          }
          k++;
        }
        const chunk = normalized.slice(i, k).trim();
        if (chunk) tokens.push({ kind: "text", value: chunk });
        i = k;
        continue;
      }
      i = j;
      continue;
    }
    // Skip unknown punctuation
    i++;
  }
  return tokens;
}

function parseBreakCond(raw: string): BreakCond | null {
  switch (raw) {
    case "pass":
    case "ok":
    case "done":
      return raw === "ok" ? "pass" : raw;
    case "fail":
      return "fail";
    case "always":
      return "always";
    case "never":
      return "never";
    default:
      return null;
  }
}

/**
 * Parse a pipeline program from composer text.
 * Returns null when there are no agent mentions (not a pipeline message).
 *
 * Bare `loop:` uses opts.defaultMax (else DEFAULT_LOOP_MAX).
 * `loop N:` sets max to N (clamped by opts.absoluteMax).
 */
export function parsePipelineProgram(
  src: string,
  opts?: PipelineParseOptions,
): PipelineProgram | null {
  const absoluteMax = clampLoopMax(
    opts?.absoluteMax ?? ABSOLUTE_LOOP_MAX,
    SYSTEM_LOOP_MAX,
  );
  const defaultMax = clampLoopMax(
    opts?.defaultMax ?? DEFAULT_LOOP_MAX,
    absoluteMax,
  );

  const tokens = tokenize(src);
  const hasAgent = tokens.some((t) => t.kind === "at");
  if (!hasAgent) return null;

  const bodyParts: string[] = [];
  const handles: string[] = [];
  const nodes: PipelineAstNode[] = [];
  let i = 0;

  const peek = () => tokens[i];
  const take = () => tokens[i++];

  function skipNl() {
    while (peek()?.kind === "nl") take();
  }

  function parseAgentSeq(): PipelineAstNode[] {
    const seq: PipelineAstNode[] = [];
    while (true) {
      skipNl();
      const t = peek();
      if (!t) break;
      if (t.kind === "at") {
        take();
        handles.push(t.handle);
        seq.push({ type: "agent", handle: t.handle });
        // optional arrows between agents
        while (peek()?.kind === "arrow") take();
        continue;
      }
      if (t.kind === "arrow") {
        take();
        continue;
      }
      break;
    }
    return seq;
  }

  function parseBreakWhen(): BreakCond | null {
    // break if pass | break pass | break if done
    skipNl();
    if (
      peek()?.kind !== "kw" ||
      (peek() as { value: string }).value !== "break"
    ) {
      return null;
    }
    take(); // break
    if (peek()?.kind === "kw" && (peek() as { value: string }).value === "if") {
      take();
    }
    const condTok = peek();
    if (condTok?.kind === "kw") {
      take();
      return parseBreakCond(condTok.value) ?? "pass";
    }
    return "pass";
  }

  function parseLoop(): PipelineAstNode | null {
    skipNl();
    if (
      peek()?.kind !== "kw" ||
      (peek() as { value: string }).value !== "loop"
    ) {
      return null;
    }
    take(); // loop
    // loop: → defaultMax; loop 15: → 15 (clamped)
    let max = defaultMax;
    if (peek()?.kind === "num") {
      max = clampLoopMax((take() as { value: number }).value, absoluteMax);
    }
    if (peek()?.kind === "colon") take();

    const body: PipelineAstNode[] = [];
    let breakWhen: BreakCond | null = null;

    // Collect body until end / endloop / next top-level structure / EOF
    while (i < tokens.length) {
      skipNl();
      const t = peek();
      if (!t) break;
      if (t.kind === "kw" && (t.value === "end" || t.value === "endloop")) {
        take();
        break;
      }
      if (t.kind === "kw" && t.value === "loop") {
        // nested loop
        const nested = parseLoop();
        if (nested) body.push(nested);
        continue;
      }
      if (t.kind === "kw" && t.value === "break") {
        breakWhen = parseBreakWhen();
        // break ends the loop body definition
        break;
      }
      if (t.kind === "at" || t.kind === "arrow") {
        body.push(...parseAgentSeq());
        continue;
      }
      if (t.kind === "text") {
        // text inside loop becomes part of global body (user brief)
        bodyParts.push(t.value);
        take();
        continue;
      }
      // Unknown — stop loop body
      break;
    }

    if (body.length === 0) {
      return null;
    }
    return { type: "loop", max, body, breakWhen };
  }

  while (i < tokens.length) {
    skipNl();
    const t = peek();
    if (!t) break;

    if (t.kind === "text") {
      bodyParts.push(t.value);
      take();
      continue;
    }
    if (t.kind === "kw" && t.value === "loop") {
      const loop = parseLoop();
      if (loop) nodes.push(loop);
      continue;
    }
    if (t.kind === "kw" && t.value === "break") {
      // top-level break is ignored (only valid inside loop)
      parseBreakWhen();
      continue;
    }
    if (t.kind === "at" || t.kind === "arrow") {
      nodes.push(...parseAgentSeq());
      continue;
    }
    if (t.kind === "kw" && (t.value === "end" || t.value === "endloop")) {
      take();
      continue;
    }
    // skip stray keywords/numbers
    take();
  }

  if (nodes.length === 0) return null;

  return {
    nodes,
    body: bodyParts.join(" ").replace(/\s+/g, " ").trim(),
    handles,
  };
}

/** Flatten agents in AST for validation / UI (loops expand as single group). */
export function collectHandles(nodes: PipelineAstNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type === "agent") out.push(n.handle);
    else out.push(...collectHandles(n.body));
  }
  return out;
}

/** Count agent invocations if loops ran to max (upper bound for UI/caps). */
export function estimateMaxAgentRuns(nodes: PipelineAstNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "agent") n += 1;
    else n += node.max * estimateMaxAgentRuns(node.body);
  }
  return n;
}

/** Pretty-print program for UI / debugging. */
export function formatPipelineProgram(
  nodes: PipelineAstNode[],
  indent = 0,
): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.type === "agent") {
      lines.push(`${pad}@${n.handle}`);
    } else {
      const br = n.breakWhen ? ` break if ${n.breakWhen}` : "";
      lines.push(`${pad}loop ${n.max}:${br}`);
      lines.push(formatPipelineProgram(n.body, indent + 1));
    }
  }
  return lines.join("\n");
}
