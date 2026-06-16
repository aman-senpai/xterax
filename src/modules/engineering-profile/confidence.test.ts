import { describe, expect, it } from "vitest";
import {
  aggregateScore,
  clamp01,
  distinctSourceCount,
  logistic,
  normalizeConfidence,
  normalizeText,
  preferenceKey,
  similarity,
  totalWeight,
} from "./confidence";
import { DEFAULT_REFINEMENT_CONFIG, type Signal } from "./types";

function sig(over: Partial<Signal>): Signal {
  return {
    id: over.id ?? "s1",
    timestamp: over.timestamp ?? 0,
    source: over.source ?? "explicit-feedback",
    scope: over.scope ?? "user",
    projectRoot: over.projectRoot ?? null,
    category: over.category ?? "general",
    preference: over.preference ?? "use TypeScript",
    evidence: over.evidence ?? "",
    weight: over.weight ?? 1,
  };
}

describe("logistic", () => {
  it("returns 0.5 at 0", () => {
    expect(logistic(0)).toBeCloseTo(0.5, 5);
  });
  it("approaches 1 for large positive", () => {
    expect(logistic(10)).toBeGreaterThan(0.99);
  });
  it("approaches 0 for large negative", () => {
    expect(logistic(-10)).toBeLessThan(0.01);
  });
});

describe("clamp01", () => {
  it("clamps negatives to 0", () => {
    expect(clamp01(-0.5)).toBe(0);
  });
  it("clamps large to 1", () => {
    expect(clamp01(5)).toBe(1);
  });
  it("keeps valid", () => {
    expect(clamp01(0.42)).toBe(0.42);
  });
  it("treats NaN as 0", () => {
    expect(clamp01(NaN)).toBe(0);
  });
});

describe("aggregateScore", () => {
  const config = DEFAULT_REFINEMENT_CONFIG;
  it("returns 0 for empty input", () => {
    expect(aggregateScore([], 0, config)).toBe(0);
  });
  it("decays old signals", () => {
    const fresh = sig({ timestamp: 0, weight: 1, source: "explicit-feedback" });
    const old = sig({
      id: "s2",
      timestamp: -config.decayHalfLifeMs,
      weight: 1,
      source: "explicit-feedback",
    });
    const freshScore = aggregateScore([fresh], 0, config);
    const oldScore = aggregateScore([old], 0, config);
    expect(freshScore).toBeGreaterThan(oldScore);
  });
  it("increases with more independent signals", () => {
    const a = sig({ id: "a", weight: 1, source: "explicit-feedback" });
    const b = sig({ id: "b", weight: 1, source: "explicit-feedback" });
    const c = sig({ id: "c", weight: 1, source: "explicit-feedback" });
    const s1 = aggregateScore([a], 0, config);
    const s3 = aggregateScore([a, b, c], 0, config);
    expect(s3).toBeGreaterThan(s1);
  });
  it("rejections pull confidence down", () => {
    const accepted = sig({ source: "accepted-change", weight: 1 });
    const rejected = sig({ source: "rejected-change", weight: 1 });
    const acc = aggregateScore([accepted], 0, config);
    const rej = aggregateScore([rejected], 0, config);
    expect(acc).toBeGreaterThan(rej);
    expect(rej).toBeLessThan(0.5);
  });
});

describe("normalizeConfidence", () => {
  it("stretches toward 1 with diverse evidence", () => {
    const config = DEFAULT_REFINEMENT_CONFIG;
    const diverse: Signal[] = [
      sig({ id: "1", source: "explicit-feedback", weight: 1 }),
      sig({ id: "2", source: "architecture-decision", weight: 1 }),
      sig({ id: "3", source: "recurring-request", weight: 1 }),
      sig({ id: "4", source: "design-critique", weight: 1 }),
      sig({ id: "5", source: "workflow-instruction", weight: 1 }),
    ];
    const single: Signal[] = [sig({ id: "1", source: "explicit-feedback", weight: 1 })];
    const scoreSingle = normalizeConfidence(
      aggregateScore(single, 0, config),
      single,
    );
    const scoreDiverse = normalizeConfidence(
      aggregateScore(diverse, 0, config),
      diverse,
    );
    expect(scoreDiverse).toBeGreaterThanOrEqual(scoreSingle);
  });
});

describe("distinctSourceCount", () => {
  it("counts unique source channels", () => {
    const s = distinctSourceCount([
      sig({ id: "1", source: "explicit-feedback" }),
      sig({ id: "2", source: "explicit-feedback" }),
      sig({ id: "3", source: "accepted-change" }),
    ]);
    expect(s).toBe(2);
  });
});

describe("totalWeight", () => {
  it("uses SOURCE_WEIGHTS multiplied by signal weight", () => {
    const total = totalWeight([
      sig({ id: "1", source: "explicit-feedback", weight: 1 }),
      sig({ id: "2", source: "rejected-change", weight: 1 }),
    ]);
    expect(total).toBeCloseTo(1.0 + -0.7, 5);
  });
});

describe("preferenceKey", () => {
  it("normalizes whitespace and case", () => {
    expect(preferenceKey("frontend", "Prefer  TypeScript")).toBe(
      preferenceKey("frontend", "prefer typescript"),
    );
  });
  it("differs across categories", () => {
    expect(preferenceKey("frontend", "x")).not.toBe(preferenceKey("backend", "x"));
  });
});

describe("normalizeText", () => {
  it("trims and lowercases and collapses whitespace", () => {
    expect(normalizeText("  Hello   WORLD  ")).toBe("hello world");
  });
});

describe("similarity", () => {
  it("returns 1 for identical normalized strings", () => {
    expect(similarity("Use TypeScript", "use typescript")).toBe(1);
  });
  it("returns 0 for empty", () => {
    expect(similarity("", "x")).toBe(0);
    expect(similarity("x", "")).toBe(0);
  });
  it("returns high for near-duplicates", () => {
    const s = similarity("use TypeScript", "use typescripts");
    expect(s).toBeGreaterThan(0.8);
  });
  it("returns low for unrelated strings", () => {
    const s = similarity("PostgreSQL", "banana");
    expect(s).toBeLessThan(0.3);
  });
});
