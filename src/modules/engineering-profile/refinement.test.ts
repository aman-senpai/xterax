import { describe, expect, it, vi } from "vitest";
import {
  buildDomainProfiles,
  buildFallbackCandidates,
  diffChanges,
  mergeProfiles,
  resolveConflict,
} from "./refinement";
import { makeBlankProfile } from "./storage";
import type { Preference, Signal } from "./types";

vi.mock("./storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./storage")>();
  return {
    ...actual,
    storage: {
      getProfile: vi.fn(),
      loadSignals: vi.fn(),
      saveProfile: vi.fn(),
      appendSnapshot: vi.fn(),
      loadSnapshots: vi.fn(),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      listProjectProfiles: vi.fn(),
      writeHumanView: vi.fn(),
    },
  };
});

vi.mock("./extraction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extraction")>();
  return {
    ...actual,
    pickExtractor: vi.fn((_config) => {
      return actual.llmExtractor;
    }),
  };
});

function pref(over: Partial<Preference>): Preference {
  return {
    id: over.id ?? "p1",
    category: over.category ?? "frontend",
    preference: over.preference ?? "Prefer TypeScript",
    confidence: over.confidence ?? 0.7,
    evidenceCount: over.evidenceCount ?? 1,
    firstObservedAt: over.firstObservedAt ?? 0,
    lastObservedAt: over.lastObservedAt ?? 0,
    signalIds: over.signalIds ?? [],
    supportingSources: over.supportingSources ?? [],
    scope: over.scope ?? "user",
    projectRoot: over.projectRoot ?? null,
    pinned: over.pinned ?? false,
    supersededBy: over.supersededBy ?? null,
  };
}

describe("diffChanges", () => {
  it("detects added preferences", () => {
    const a = pref({ id: "a" });
    const changes = diffChanges([], [a]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("added");
  });
  it("detects removed preferences", () => {
    const a = pref({ id: "a" });
    const changes = diffChanges([a], []);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("removed");
  });
  it("detects modified preferences (confidence change)", () => {
    const before = pref({ id: "a", confidence: 0.5, preference: "Same" });
    const after = pref({ id: "a", confidence: 0.8, preference: "Same" });
    const changes = diffChanges([before], [after]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.kind).toBe("modified");
    expect(changes[0]?.confidenceDelta).toBeCloseTo(0.3, 5);
  });
  it("ignores identical preferences", () => {
    const a = pref({ id: "a", confidence: 0.5, preference: "Same" });
    const changes = diffChanges([a], [{ ...a }]);
    expect(changes).toHaveLength(0);
  });
});

describe("resolveConflict", () => {
  it("user wins when project is null", () => {
    const u = pref({ id: "u", preference: "Use Postgres" });
    const result = resolveConflict(u, null);
    expect(result.effective?.id).toBe("u");
  });
  it("project wins when user is null", () => {
    const p = pref({ id: "p", preference: "Use MySQL" });
    const result = resolveConflict(null, p);
    expect(result.effective?.id).toBe("p");
  });
  it("project overrides user on direct conflict", () => {
    const u = pref({ id: "u", preference: "Use Postgres for everything" });
    const p = pref({ id: "p", preference: "Use MySQL for everything" });
    const result = resolveConflict(u, p);
    expect(result.effective?.id).toBe("p");
    expect(result.overridden?.id).toBe("u");
  });
  it("project overrides on fuzzy conflict", () => {
    const u = pref({ id: "u", preference: "Prefer TypeScript" });
    const p = pref({ id: "p", preference: "Prefer TypeScript" });
    const result = resolveConflict(u, p);
    expect(result.effective?.id).toBe("p");
  });
});

describe("buildDomainProfiles", () => {
  it("groups preferences by category", () => {
    const prefs = [
      pref({ id: "1", category: "frontend" }),
      pref({ id: "2", category: "frontend" }),
      pref({ id: "3", category: "backend" }),
    ];
    const domains = buildDomainProfiles(prefs, "", 0);
    expect(domains.frontend.preferences).toHaveLength(2);
    expect(domains.backend.preferences).toHaveLength(1);
  });
  it("sorts each domain by confidence", () => {
    const prefs = [
      pref({ id: "1", confidence: 0.3 }),
      pref({ id: "2", confidence: 0.9 }),
      pref({ id: "3", confidence: 0.6 }),
    ];
    const domains = buildDomainProfiles(prefs, "", 0);
    const front = domains.frontend.preferences;
    expect(front[0]?.confidence).toBe(0.9);
    expect(front[1]?.confidence).toBe(0.6);
    expect(front[2]?.confidence).toBe(0.3);
  });
});

describe("mergeProfiles", () => {
  it("returns user when no project", () => {
    const user = makeBlankProfile("user", null);
    const merged = mergeProfiles(user, null, 0);
    expect(merged).toBe(user);
  });
  it("merges non-conflicting user + project preferences", () => {
    const user = makeBlankProfile("user", null);
    const project = makeBlankProfile("project", "/p");
    user.preferences = [
      pref({ id: "u1", category: "frontend", preference: "Use TypeScript" }),
    ];
    project.preferences = [
      pref({ id: "p1", category: "backend", preference: "Use Postgres" }),
    ];
    const merged = mergeProfiles(user, project, 0);
    expect(merged.preferences.length).toBe(2);
  });
  it("project wins on direct conflict and records superseded", () => {
    const user = makeBlankProfile("user", null);
    const project = makeBlankProfile("project", "/p");
    user.preferences = [
      pref({ id: "u1", preference: "Use Postgres for the user service" }),
    ];
    project.preferences = [
      pref({ id: "p1", preference: "Use Postgres for the user service" }),
    ];
    const merged = mergeProfiles(user, project, 0);
    const winning = merged.preferences.find((p) =>
      p.preference.includes("Postgres"),
    );
    expect(winning?.id).toBe("p1");
    expect(winning?.supersededBy).toBe("u1");
  });
  it("keeps both preferences when they are different", () => {
    const user = makeBlankProfile("user", null);
    const project = makeBlankProfile("project", "/p");
    user.preferences = [
      pref({ id: "u1", preference: "Use Postgres for the user service" }),
    ];
    project.preferences = [
      pref({ id: "p1", preference: "Use MySQL for the user service" }),
    ];
    const merged = mergeProfiles(user, project, 0);
    expect(merged.preferences.length).toBe(2);
  });
});

describe("buildFallbackCandidates", () => {
  function sig(over: Partial<Signal>): Signal {
    return {
      id: over.id ?? "s1",
      timestamp: over.timestamp ?? 0,
      source: over.source ?? "explicit-feedback",
      scope: over.scope ?? "project",
      projectRoot: over.projectRoot ?? "/tmp/terax-test-isolated",
      category: over.category ?? "general",
      preference: over.preference ?? "Prefer feature-based folders",
      evidence: over.evidence ?? "",
      weight: over.weight ?? 1,
    };
  }

  it("groups signals with the same preference into one candidate", () => {
    const candidates = buildFallbackCandidates(
      [
        sig({ id: "s1", preference: "Prefer feature-based folders" }),
        sig({ id: "s2", preference: "Prefer feature-based folders" }),
      ],
      [],
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.mappedSignalIds).toEqual(["s1", "s2"]);
  });
});

describe("refineProfile", () => {
  it("does not locally group signals when LLM returns no candidates (pure LLM-driven path only; no fuzzy/local fallback in refine)", async () => {
    const { refineProfile } = await import("./refinement");
    const { storage } = await import("./storage");
    const { pickExtractor } = await import("./extraction");

    vi.mocked(storage.getProfile).mockResolvedValueOnce(null);
    vi.mocked(storage.loadSignals).mockResolvedValueOnce([
      {
        id: "s1",
        timestamp: Date.now(),
        source: "explicit-feedback",
        scope: "project",
        projectRoot: "/tmp/terax-test-isolated",
        category: "general",
        preference: "Prefer feature-based folders",
        evidence: "user said so",
        weight: 1,
      },
    ]);

    const mockExtractor = vi.fn().mockResolvedValue({
      candidates: [],
      discarded: [],
      provider: "openai",
    });
    vi.mocked(pickExtractor).mockReturnValueOnce(mockExtractor);

    const deps = {
      getKeys: () => ({}),
      getConfig: () => ({
        provider: "openai",
        modelId: "gpt-5",
        minConfidence: 0.3,
        maxAgeMs: 100000,
        decayHalfLifeMs: 1000000,
        promotionThreshold: 0.7,
        demotionThreshold: 0.2,
        maxPreferences: 10,
        splitMinPreferences: 5,
        splitMinAverageConfidence: 0.6,
        splitMinShare: 0.2,
      }),
    };

    const res = await refineProfile(deps as any, {
      scope: "project",
      projectRoot: "/test",
    });
    // Pure LLM path: empty candidates from extractor means no new prefs invented locally from raw signals.
    // Signals stay in the log; a future successful LLM extraction will see them + any priors and must consolidate.
    // We still produce a (empty) profile so writes/snapshots can occur.
    expect(res.profile.preferences.length).toBe(0);
  });
  it("merges prior preferences when instructed by the LLM mergedPriorIds", async () => {
    const { refineProfile } = await import("./refinement");
    const { storage } = await import("./storage");
    const { pickExtractor } = await import("./extraction");

    const now = Date.now();
    vi.mocked(storage.getProfile).mockResolvedValueOnce({
      id: "p1",
      scope: "project",
      projectRoot: "/test",
      generatedAt: now,
      summary: "",
      preferences: [
        pref({
          id: "1",
          preference: "Prefer Tailwind CSS for styling",
          confidence: 0.8,
          lastObservedAt: now,
        }),
        pref({
          id: "2",
          preference: "Prefer TailwindCSS for styling",
          confidence: 0.7,
          lastObservedAt: now,
        }),
      ],
      domains: {},
    });

    vi.mocked(storage.loadSignals).mockResolvedValueOnce([]);

    const deps = {
      getKeys: () => ({}),
      getConfig: () => ({
        provider: "test-llm",
        modelId: "test-llm",
        minConfidence: 0.3,
        maxAgeMs: 100000,
        decayHalfLifeMs: 1000000,
        promotionThreshold: 0.7,
        demotionThreshold: 0.2,
        maxPreferences: 10,
        splitMinPreferences: 5,
        splitMinAverageConfidence: 0.6,
        splitMinShare: 0.2,
      }),
    };

    const mockExtractor = vi.fn().mockResolvedValue({
      candidates: [
        {
          category: "frontend",
          preference: "Prefer Tailwind CSS for styling",
          evidence: "consolidated style preference",
          weight: 1.0,
          mergedPriorIds: ["1", "2"],
          mappedSignalIds: [],
        },
      ],
      discarded: [],
      provider: "test-llm",
    });

    vi.mocked(pickExtractor).mockReturnValueOnce(mockExtractor);

    const res = await refineProfile(deps as any, {
      scope: "project",
      projectRoot: "/test",
      now,
    });
    expect(res.profile.preferences).toHaveLength(1);
    expect(res.profile.preferences[0]?.id).toBe("1");
    expect(res.profile.preferences[0]?.preference).toBe(
      "Prefer Tailwind CSS for styling",
    );
  });

  it("decays unmapped priors but keeps pinned priors unchanged", async () => {
    const { refineProfile } = await import("./refinement");
    const { storage } = await import("./storage");
    const now = Date.now();

    vi.mocked(storage.getProfile).mockResolvedValueOnce({
      id: "p1",
      scope: "project",
      projectRoot: "/test",
      generatedAt: now,
      summary: "",
      preferences: [
        pref({
          id: "1",
          preference: "Prefer Vitest",
          confidence: 0.8,
          lastObservedAt: now - 100000,
          pinned: false,
        }),
        pref({
          id: "2",
          preference: "Prefer React",
          confidence: 0.9,
          lastObservedAt: now - 100000,
          pinned: true,
        }),
      ],
      domains: {},
    });

    vi.mocked(storage.loadSignals).mockResolvedValueOnce([]);

    const deps = {
      getKeys: () => ({}),
      getConfig: () => ({
        provider: "openai",
        modelId: "gpt-5",
        minConfidence: 0.1,
        maxAgeMs: 1000000,
        decayHalfLifeMs: 100000,
        promotionThreshold: 0.7,
        demotionThreshold: 0.2,
        maxPreferences: 10,
        splitMinPreferences: 5,
        splitMinAverageConfidence: 0.6,
        splitMinShare: 0.2,
      }),
    };

    const res = await refineProfile(deps as any, {
      scope: "project",
      projectRoot: "/test",
      now,
    });
    const decayed = res.profile.preferences.find((p) => p.id === "1");
    const pinned = res.profile.preferences.find((p) => p.id === "2");

    expect(decayed?.confidence).toBeCloseTo(0.4, 3);
    expect(pinned?.confidence).toBe(0.9);
  });

  it("respects LLM mergedPriorIds mapping", async () => {
    const { refineProfile } = await import("./refinement");
    const { storage } = await import("./storage");
    const { pickExtractor } = await import("./extraction");

    vi.mocked(storage.getProfile).mockResolvedValueOnce({
      id: "p1",
      scope: "project",
      projectRoot: "/test",
      generatedAt: Date.now(),
      summary: "",
      preferences: [
        pref({
          id: "prior-id",
          preference: "Older preference",
          confidence: 0.5,
        }),
      ],
      domains: {},
    });

    const sig = {
      id: "sig-id",
      category: "frontend",
      preference: "Older preference version 2",
      evidence: "changed in code",
      source: "accepted-change",
      timestamp: Date.now(),
      weight: 1.0,
    };
    vi.mocked(storage.loadSignals).mockResolvedValueOnce([sig as any]);

    const deps = {
      getKeys: () => ({}),
      getConfig: () => ({
        provider: "test-llm",
        modelId: "test-llm",
        minConfidence: 0.1,
        maxAgeMs: 1000000,
        decayHalfLifeMs: 100000,
        promotionThreshold: 0.7,
        demotionThreshold: 0.2,
        maxPreferences: 10,
        splitMinPreferences: 5,
        splitMinAverageConfidence: 0.6,
        splitMinShare: 0.2,
      }),
    };

    const mockExtractor = vi.fn().mockResolvedValue({
      candidates: [
        {
          category: "frontend",
          preference: "Older preference version 2",
          evidence: "changed in code",
          weight: 1.0,
          mergedPriorIds: ["prior-id"],
          mappedSignalIds: ["sig-id"],
        },
      ],
      discarded: [],
      provider: "test-llm",
    });

    vi.mocked(pickExtractor).mockReturnValueOnce(mockExtractor);

    const res = await refineProfile(deps as any, {
      scope: "project",
      projectRoot: "/test",
    });
    const resultPref = res.profile.preferences[0];
    expect(resultPref?.id).toBe("prior-id");
    expect(resultPref?.preference).toBe("Older preference version 2");
    expect(resultPref?.signalIds).toContain("sig-id");
  });
});
