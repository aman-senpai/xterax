import { tool } from "ai";
import { z } from "zod";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { explainPreference } from "./runtime";
import { getCachedConfig } from "./storage";
import {
  getMergedProfile,
  getProfile,
  listProjectProfiles,
  recordExplicitFeedback,
  recordRejectedChange,
  refineUserProfile,
  refineProjectProfile,
  rollbackProfile,
  setRefinementConfig,
  showProfileHistory,
  showSignals,
} from "./api";
import { isDomain, type Domain } from "./types";
import type { ExtractorDeps } from "./extraction";
import type { ToolContext } from "@/modules/ai/tools/context";

function chatDeps(): ExtractorDeps {
  const chat = useChatStore.getState();
  return {
    getKeys: () => chat.apiKeys,
    getModelId: () => chat.selectedModelId,
    getLocalConfig: () => undefined,
    getConfig: () => getCachedConfig(),
  };
}

const dom = z.string().refine(isDomain, "must be a known domain");
const sourceSchema = z.enum([
  "explicit-feedback",
  "accepted-change",
  "rejected-change",
  "user-modification",
  "architecture-decision",
  "recurring-request",
  "design-critique",
  "workflow-instruction",
  "config-setting",
]);

export function buildProfileTools(_ctx: ToolContext) {
  return {
    record_preference_signal: tool({
      description:
        "Record a user preference signal observed in this session. Use for stable, long-term preferences (e.g. prefer TypeScript, use server components, keep code concise). Do NOT record one-off task instructions. The signal is appended-only; refinement later aggregates it into a confidence-scored profile entry.",
      inputSchema: z.object({
        category: dom.describe(
          "Domain the preference belongs to: architecture, frontend, backend, design, ux, testing, documentation, workflow, or general.",
        ),
        preference: z
          .string()
          .min(3)
          .max(280)
          .describe("Concise, declarative preference (e.g. 'Prefer TypeScript')."),
        evidence: z
          .string()
          .min(1)
          .describe("Short quote or paraphrase of the user statement that motivated the signal."),
        source: sourceSchema.default("explicit-feedback"),
        scope: z.enum(["user", "project"]).default("user"),
        weight: z.number().min(0.1).max(2).default(1).optional(),
      }),
      execute: async (input) => {
        const projectRoot = input.scope === "project"
          ? (useChatStore.getState().live.getProjectRoot() ??
              useChatStore.getState().live.getWorkspaceRoot() ??
              null)
          : null;
        const result = await recordExplicitFeedback(input.preference, input.evidence, {
          category: input.category as Domain,
          projectRoot,
          weight: input.weight ?? 1,
        });
        return {
          ok: result.accepted,
          reason: result.reason,
          signalId: result.signal.id,
        };
      },
    }),

    record_rejection_signal: tool({
      description:
        "Record a NEGATIVE signal: a user pushback on the agent's output. Examples: do not do X, I told you not to Y. Refinement will lower confidence for matching preferences. Do NOT use for one-off feedback on a single file; only for stable patterns.",
      inputSchema: z.object({
        category: dom,
        preference: z.string().min(3).max(280),
        evidence: z.string().min(1),
      }),
      execute: async (input) => {
        const result = await recordRejectedChange(input.preference, input.evidence, {
          category: input.category as Domain,
          projectRoot:
            useChatStore.getState().live.getProjectRoot() ??
            useChatStore.getState().live.getWorkspaceRoot() ??
            null,
        });
        return {
          ok: result.accepted,
          reason: result.reason,
          signalId: result.signal.id,
        };
      },
    }),

    refine_profile: tool({
      description:
        "Run a profile refinement pass. Aggregates new signals into confidence-scored preferences, decays stale ones, resolves conflicts, and writes a new snapshot. Usually called automatically by the autonomous continuous-learning agent; you only need to call it explicitly when the user asks or to force a refresh mid-session.",
      inputSchema: z.object({
        scope: z.enum(["user", "project"]).default("user"),
        note: z.string().max(120).optional(),
      }),
      execute: async (input) => {
        const root =
          input.scope === "project"
            ? (useChatStore.getState().live.getProjectRoot() ??
                useChatStore.getState().live.getWorkspaceRoot() ??
                null)
            : null;
        const result = input.scope === "project" && root
          ? await refineProjectProfile(chatDeps(), root, {
              note: input.note ?? null,
            })
          : await refineUserProfile(chatDeps(), {
              note: input.note ?? null,
            });
        return {
          ok: true,
          added: result.added.length,
          removed: result.removed.length,
          modified: result.modified.length,
          snapshotId: result.snapshot.id,
          profileId: result.profile.id,
          generatedAt: result.profile.generatedAt,
        };
      },
    }),

    get_profile: tool({
      description:
        "Get the current engineering profile. Use to see what the agent has learned about the user's preferences before planning. Returns preferences with confidence, evidence counts, and the most recent snapshot id.",
      inputSchema: z.object({
        scope: z.enum(["user", "project", "merged"]).default("merged"),
        domain: dom.optional(),
        minConfidence: z.number().min(0).max(1).default(0.4).optional(),
        limit: z.number().int().min(1).max(50).default(20).optional(),
      }),
      execute: async (input) => {
        const root = useChatStore.getState().live.getWorkspaceRoot() ?? null;
        const profile =
          input.scope === "merged"
            ? await getMergedProfile(root)
            : await getProfile({
                scope: input.scope === "project" ? "project" : "user",
                projectRoot: input.scope === "project" ? root : null,
              });
        const min = input.minConfidence ?? 0.4;
        const limit = input.limit ?? 20;
        let prefs = profile.preferences.filter((p) => p.confidence >= min);
        if (input.domain) prefs = prefs.filter((p) => p.category === input.domain);
        prefs = prefs.slice(0, limit);
        return {
          scope: profile.scope,
          projectRoot: profile.projectRoot,
          generatedAt: profile.generatedAt,
          summary: profile.summary,
          preferences: prefs.map((p) => ({
            id: p.id,
            category: p.category,
            preference: p.preference,
            confidence: p.confidence,
            evidenceCount: p.evidenceCount,
            firstObservedAt: p.firstObservedAt,
            lastObservedAt: p.lastObservedAt,
            supportingSources: p.supportingSources,
          })),
        };
      },
    }),

    explain_preference: tool({
      description:
        "Explain why the agent believes a given preference exists. Returns the underlying evidence signals, when they were observed, and which source channels contributed. Use to answer 'why does the agent think this' questions from the user.",
      inputSchema: z.object({
        preferenceId: z.string().describe("Preference id from get_profile output."),
      }),
      execute: async (input) => {
        const root = useChatStore.getState().live.getWorkspaceRoot() ?? null;
        const exp = await explainPreference(input.preferenceId, root);
        if (!exp) return { found: false };
        return {
          found: true,
          preference: {
            id: exp.preference.id,
            category: exp.preference.category,
            preference: exp.preference.preference,
            confidence: exp.preference.confidence,
            evidenceCount: exp.preference.evidenceCount,
            firstObservedAt: exp.preference.firstObservedAt,
            lastObservedAt: exp.preference.lastObservedAt,
          },
          effectiveScope: exp.effectiveScope,
          overriddenBy: exp.overriddenBy
            ? {
                id: exp.overriddenBy.id,
                preference: exp.overriddenBy.preference,
                scope: exp.overriddenBy.scope,
                confidence: exp.overriddenBy.confidence,
              }
            : null,
          evidence: exp.evidence,
          totalWeight: exp.totalWeight,
          sourceBreakdown: exp.sourceBreakdown,
        };
      },
    }),

    show_profile_history: tool({
      description:
        "List the refinement snapshots for a profile. Each snapshot is a point-in-time profile that can be diffed or rolled back to.",
      inputSchema: z.object({
        scope: z.enum(["user", "project"]).default("user"),
        limit: z.number().int().min(1).max(50).default(10).optional(),
      }),
      execute: async (input) => {
        const root =
          input.scope === "project"
            ? (useChatStore.getState().live.getWorkspaceRoot() ?? null)
            : null;
        const snapshots = await showProfileHistory(input.scope, root, input.limit ?? 10);
        return snapshots.map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          reason: s.reason,
          note: s.note,
          added: s.changes.filter((c) => c.kind === "added").length,
          removed: s.changes.filter((c) => c.kind === "removed").length,
          modified: s.changes.filter((c) => c.kind === "modified").length,
        }));
      },
    }),

    show_signals: tool({
      description:
        "List recent preference signals (raw observations) for the current scope. Useful for auditing what has been observed and confirming a signal was recorded.",
      inputSchema: z.object({
        scope: z.enum(["user", "project"]).default("user"),
        limit: z.number().int().min(1).max(200).default(50).optional(),
      }),
      execute: async (input) => {
        const root =
          input.scope === "project"
            ? (useChatStore.getState().live.getWorkspaceRoot() ?? null)
            : null;
        const list = await showSignals(input.scope, root, input.limit ?? 50);
        return list.map((s) => ({
          id: s.id,
          timestamp: s.timestamp,
          source: s.source,
          scope: s.scope,
          category: s.category,
          preference: s.preference,
          evidence: s.evidence,
          weight: s.weight,
        }));
      },
    }),

    rollback_profile: tool({
      description:
        "Roll the profile back to a previous snapshot. Creates a new snapshot whose contents are the old state; never destroys history. Use only when the user explicitly asks to roll back.",
      inputSchema: z.object({
        snapshotId: z.string().describe("Snapshot id from show_profile_history."),
        scope: z.enum(["user", "project"]).default("user"),
      }),
      needsApproval: true,
      execute: async (input) => {
        const root =
          input.scope === "project"
            ? (useChatStore.getState().live.getWorkspaceRoot() ?? null)
            : null;
        const result = await rollbackProfile(input.snapshotId, input.scope, root);
        if (!result) return { ok: false, reason: "snapshot-not-found" };
        return {
          ok: true,
          snapshotId: result.snapshot.id,
          added: result.added.length,
          removed: result.removed.length,
          modified: result.modified.length,
        };
      },
    }),

    set_refinement_config: tool({
      description:
        "Update the refinement model configuration. Allows switching between heuristic and LLM-based extraction, tuning confidence thresholds, and adjusting when domains are split into their own .terax/<domain>/profile.md subdirectory. Heuristic is the safe default; switch to a configured LLM provider for higher-quality preference extraction.",
      inputSchema: z.object({
        provider: z
          .enum([
            "heuristic",
            "openai",
            "anthropic",
            "google",
            "groq",
            "openrouter",
            "openai-compatible",
            "lmstudio",
            "mlx",
            "ollama",
          ])
          .default("heuristic"),
        modelId: z.string().optional(),
        minConfidence: z.number().min(0).max(1).optional(),
        decayHalfLifeDays: z.number().int().min(1).max(365).optional(),
        promotionThreshold: z.number().min(0).max(1).optional(),
        demotionThreshold: z.number().min(0).max(1).optional(),
        maxPreferences: z.number().int().min(10).max(2000).optional(),
        splitMinPreferences: z.number().int().min(2).max(100).optional(),
        splitMinAverageConfidence: z.number().min(0).max(1).optional(),
        splitMinShare: z.number().min(0).max(1).optional(),
      }),
      execute: async (input) => {
        const next = await setRefinementConfig({
          provider: input.provider,
          modelId: input.modelId,
          minConfidence: input.minConfidence,
          decayHalfLifeMs: input.decayHalfLifeDays
            ? input.decayHalfLifeDays * 24 * 60 * 60 * 1000
            : undefined,
          splitMinPreferences: input.splitMinPreferences,
          splitMinAverageConfidence: input.splitMinAverageConfidence,
          splitMinShare: input.splitMinShare,
          promotionThreshold: input.promotionThreshold,
          demotionThreshold: input.demotionThreshold,
          maxPreferences: input.maxPreferences,
        });
        return { ok: true, config: next };
      },
    }),

    list_project_profiles: tool({
      description:
        "List all project profiles the user has built across workspaces. Useful for cross-project audits.",
      inputSchema: z.object({}).passthrough(),
      execute: async () => {
        const list = await listProjectProfiles();
        return list.map((p) => ({
          projectRoot: p.root,
          generatedAt: p.profile.generatedAt,
          preferenceCount: p.profile.preferences.length,
          topCategories: topCategoriesOf(p.profile),
        }));
      },
    }),
  } as const;
}

function topCategoriesOf(profile: import("./types").Profile): string[] {
  const counts = new Map<string, number>();
  for (const p of profile.preferences) {
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c);
}
