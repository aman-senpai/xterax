import { describe, expect, it } from "vitest";
import { buildDomainProfiles } from "./refinement";
import { DEFAULT_REFINEMENT_CONFIG, type Preference } from "./types";

function pref(
  over: Partial<Preference> & { category: string; confidence?: number },
): Preference {
  return {
    id: over.id ?? `p-${Math.random().toString(36).slice(2)}`,
    canonicalRuleId: over.canonicalRuleId ?? `${over.category}_prefer-x`,
    category: over.category,
    preference: over.preference ?? "Prefer X",
    confidence: over.confidence ?? 0.7,
    evidenceCount: over.evidenceCount ?? 1,
    firstObservedAt: over.firstObservedAt ?? 0,
    lastObservedAt: over.lastObservedAt ?? 0,
    signalIds: over.signalIds ?? [],
    supportingSources: over.supportingSources ?? [],
    scope: over.scope ?? "user",
    projectRoot: over.projectRoot ?? null,
    reinforcement: over.reinforcement ?? 1,
    pinned: over.pinned ?? false,
    supersededBy: over.supersededBy ?? null,
  };
}

describe("buildDomainProfiles — dynamic domain creation", () => {
  it("creates a domain for any string, not just known hints", () => {
    const prefs = [pref({ id: "1", category: "swift" })];
    const domains = buildDomainProfiles(prefs, "", 0);
    expect(domains.swift).toBeDefined();
    expect(domains.swift.preferences).toHaveLength(1);
  });

  it("creates multiple distinct domains from free-form categories", () => {
    const prefs = [
      pref({ id: "1", category: "swift" }),
      pref({ id: "2", category: "swiftui" }),
      pref({ id: "3", category: "elixir" }),
      pref({ id: "4", category: "phoenix" }),
    ];
    const domains = buildDomainProfiles(prefs, "", 0);
    expect(Object.keys(domains).sort()).toEqual([
      "elixir",
      "phoenix",
      "swift",
      "swiftui",
    ]);
  });

  it("returns empty domains for empty preferences", () => {
    const domains = buildDomainProfiles([], "", 0);
    expect(Object.keys(domains)).toHaveLength(0);
  });
});

describe("buildDomainProfiles — split thresholds", () => {
  it("does NOT split a domain below the preference count threshold", () => {
    const prefs = Array.from({ length: 3 }, (_, i) =>
      pref({ id: `p${i}`, category: "design", confidence: 0.9 }),
    );
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      {},
    );
    expect(domains.design.split).toBe(false);
    expect(domains.design.splitPath).toBeNull();
  });

  it("splits a domain that meets all three thresholds", () => {
    const prefs = Array.from({ length: 10 }, (_, i) =>
      pref({ id: `p${i}`, category: "design", confidence: 0.9 }),
    );
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      {},
    );
    expect(domains.design.split).toBe(true);
    expect(domains.design.splitPath).toBe(".xterax/design/profile.md");
  });

  it("does NOT split if average confidence is below threshold", () => {
    const prefs = Array.from({ length: 10 }, (_, i) =>
      pref({ id: `p${i}`, category: "design", confidence: 0.3 }),
    );
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      {},
    );
    expect(domains.design.split).toBe(false);
  });

  it("does NOT split if domain share of total profile is too small", () => {
    const prefs = [
      ...Array.from({ length: 6 }, (_, i) =>
        pref({ id: `d${i}`, category: "design", confidence: 0.9 }),
      ),
      ...Array.from({ length: 100 }, (_, i) =>
        pref({ id: `o${i}`, category: "general", confidence: 0.9 }),
      ),
    ];
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      {},
    );
    expect(domains.design.split).toBe(false);
  });

  it("preserves prior split state across refinements (sticky splits)", () => {
    const prefs = Array.from({ length: 2 }, (_, i) =>
      pref({ id: `p${i}`, category: "design", confidence: 0.9 }),
    );
    const prior = {
      design: {
        category: "design",
        summary: "",
        preferences: [],
        updatedAt: 0,
        split: true,
        splitPath: ".xterax/design/profile.md",
      },
    };
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      prior,
    );
    expect(domains.design.split).toBe(true);
    expect(domains.design.splitPath).toBe(".xterax/design/profile.md");
  });

  it("uses the configured thresholds, not the defaults", () => {
    const prefs = Array.from({ length: 3 }, (_, i) =>
      pref({ id: `p${i}`, category: "design", confidence: 0.9 }),
    );
    const config = {
      ...DEFAULT_REFINEMENT_CONFIG,
      splitMinPreferences: 2,
      splitMinAverageConfidence: 0.5,
      splitMinShare: 0.5,
    };
    const domains = buildDomainProfiles(prefs, "", 0, config, {});
    expect(domains.design.split).toBe(true);
  });

  it("normalizes the domain name in the split path", () => {
    const prefs = Array.from({ length: 6 }, (_, i) =>
      pref({ id: `p${i}`, category: "Design System", confidence: 0.9 }),
    );
    const domains = buildDomainProfiles(
      prefs,
      "",
      0,
      DEFAULT_REFINEMENT_CONFIG,
      {},
    );
    expect(domains["Design System"].split).toBe(true);
    expect(domains["Design System"].splitPath).toBe(
      ".xterax/design-system/profile.md",
    );
  });
});
