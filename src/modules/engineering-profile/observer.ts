import {
  recordExplicitFeedback,
  recordRecurringRequest,
  recordRejectedChange,
  recordUserModification,
} from "./signals";
import { storage } from "./storage";
import { preferenceKey, normalizeText } from "./confidence";
import type { Domain, Signal } from "./types";

/**
 * Conservative patterns that look like stable preferences. Anything not
 * matching these patterns is NOT auto-recorded — the agent must call
 * `record_preference_signal` explicitly for everything else. This keeps
 * the system from polluting the profile with one-off instructions.
 */
const PREFERENCE_PATTERNS: RegExp[] = [
  /\b(prefer|always|never|avoid|don't use|do not use|stop using|i (like|hate|love|prefer)|please (always|never))\b/i,
  /\b(use|stick to|standardize on|default to) [a-z][\w .+/-]{2,40}\b/i,
  /\b(feature[- ]based|domain[- ]driven|layered|monorepo|hexagonal)\b.*\b(folder|structure|layout|architecture|approach)\b/i,
];

const REJECTION_PATTERNS: RegExp[] = [
  /\b(don'?t (do|use|write|add)|never (do|use|write|add)|stop (using|doing|writing|adding)|i (told|asked) you (not to|to not)|that'?s wrong|that'?s not (how|what))\b/i,
];

const RECURRING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const RECURRING_THRESHOLD = 3;

const CATEGORY_HINTS: Array<{ keywords: RegExp; category: Domain }> = [
  { keywords: /\b(react|component|css|tailwind|frontend|ui|ux|design|figma|ts|tsx|jsx|html|dom|webgl|render|hook|state manager)\b/i, category: "frontend" },
  { keywords: /\b(api|server|backend|sql|database|postgres|mysql|endpoint|route|graphql|grpc|redis|queue|worker|express|hono|fastapi)\b/i, category: "backend" },
  { keywords: /\b(architect|microservice|monolith|module|domain|service|hexagonal|cqrs|event[- ]driven|system design|adr)\b/i, category: "architecture" },
  { keywords: /\b(test|spec|vitest|jest|cypress|playwright|coverage|mock|integration test|unit test|e2e)\b/i, category: "testing" },
  { keywords: /\b(readme|docs|changelog|comment|jsdoc|tsdoc|swagger|openapi|migration)\b/i, category: "documentation" },
  { keywords: /\b(git|pr|merge|rebase|branch|ci|cd|pipeline|deploy|release|workflow|standup|ticket)\b/i, category: "workflow" },
  { keywords: /\b(design|color|palette|typography|font|spacing|layout|grid|icon|brand|visual|motion)\b/i, category: "design" },
  { keywords: /\b(accessibility|a11y|aria|wcag|usability|onboarding|empty state|microcopy|focus|keyboard)\b/i, category: "ux" },
];

export type ObservationInput = {
  text: string;
  projectRoot: string | null;
  timestamp?: number;
};

export type ObservationResult = {
  recorded: Signal[];
  skipped: string[];
};

/**
 * Passively observes a user message and records any signals that look
 * like stable preferences. Conservative by design: explicit phrasing
 * ("always use", "never", "prefer") AND no one-off indicators ("for this
 * file", "today", "tmp"). Otherwise the message is left for the agent
 * to record explicitly via the AI tool.
 */
export async function observeUserMessage(
  input: ObservationInput,
): Promise<ObservationResult> {
  const text = (input.text ?? "").trim();
  if (!text) return { recorded: [], skipped: [] };

  const recorded: Signal[] = [];
  const skipped: string[] = [];

  if (isOneOff(text)) {
    skipped.push("one-off-indicator");
    return { recorded, skipped };
  }

  const explicit = extractExplicitPreference(text);
  if (explicit) {
    const category = hintCategory(explicit);
    const result = await recordExplicitFeedback(explicit, text.slice(0, 240), {
      category,
      projectRoot: input.projectRoot,
    });
    if (result.accepted) {
      recorded.push(result.signal);
    } else {
      skipped.push(result.reason ?? "rejected");
    }
    return { recorded, skipped };
  }

  if (REJECTION_PATTERNS.some((p) => p.test(text))) {
    const subject = extractRejectionSubject(text);
    if (subject && !isOneOff(subject)) {
      const category = hintCategory(subject);
      const result = await recordRejectedChange(subject, text.slice(0, 240), {
        category,
        projectRoot: input.projectRoot,
      });
      if (result.accepted) recorded.push(result.signal);
    }
    return { recorded, skipped };
  }

  const recurring = await detectRecurring(text, input.projectRoot, input.timestamp);
  if (recurring) {
    const category = hintCategory(recurring);
    const result = await recordRecurringRequest(recurring, text.slice(0, 240), {
      category,
      projectRoot: input.projectRoot,
      weight: 0.6,
    });
    if (result.accepted) recorded.push(result.signal);
  }
  return { recorded, skipped };
}

const ONE_OFF_HINTS = [
  /\b(in this file|on this page|for this (task|pr|file)|today|tmp|todo|hack|fixup|wip)\b/i,
  /\b(please (fix|update|rename|change|add|delete|run|execute|try))\b/i,
  /\b(can you|could you|would you|will you|let's|lets)\b/i,
];

function isOneOff(text: string): boolean {
  return ONE_OFF_HINTS.some((p) => p.test(text));
}

function extractExplicitPreference(text: string): string | null {
  if (!PREFERENCE_PATTERNS.some((p) => p.test(text))) return null;
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (PREFERENCE_PATTERNS.some((p) => p.test(s)) && !isOneOff(s)) {
      return cleanSentence(s);
    }
  }
  return null;
}

function extractRejectionSubject(text: string): string | null {
  const m = text.match(/(?:don'?t|never|stop|i (?:told|asked) you (?:not )?to)\s+([a-z][\w .+/-]{2,60})/i);
  if (m?.[1]) return cleanSentence(m[1]);
  return null;
}

function cleanSentence(s: string): string {
  let out = s.trim();
  out = out.replace(/^[,.;:\-–—\s]+/, "").replace(/[,.;:\-–—\s]+$/, "");
  if (out.length > 0) out = out[0].toUpperCase() + out.slice(1);
  return out;
}

function hintCategory(text: string): Domain {
  for (const { keywords, category } of CATEGORY_HINTS) {
    if (keywords.test(text)) return category;
  }
  return "general";
}

async function detectRecurring(
  text: string,
  projectRoot: string | null,
  timestamp: number = Date.now(),
): Promise<string | null> {
  const norm = normalizeText(text);
  if (norm.length < 8) return null;
  const signals = await storage.loadSignals("user", projectRoot);
  const since = (timestamp ?? Date.now()) - RECURRING_WINDOW_MS;
  let count = 0;
  for (const s of signals) {
    if (s.timestamp < since) continue;
    const sn = normalizeText(s.preference);
    if (sn === norm) count++;
  }
  if (count + 1 >= RECURRING_THRESHOLD) {
    return text.slice(0, 240);
  }
  return null;
}

export { preferenceKey, recordUserModification };
