import { describe, expect, it } from "vitest";
import {
  buildDomainProfiles,
  diffChanges,
  mergeProfiles,
  resolveConflict,
} from "./refinement";
import { makeBlankProfile } from "./storage";
import type { Preference } from "./types";

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
    const winning = merged.preferences.find((p) => p.preference.includes("Postgres"));
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
