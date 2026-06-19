import { describe, expect, it } from "vitest";
import { classifyTask, isSkeletonProfileMd } from "./runtime";

describe("classifyTask", () => {
  it("classifies frontend tasks", () => {
    const domains = classifyTask(
      "Build a new React component using Tailwind and shadcn for the user settings page",
    );
    expect(domains).toContain("frontend");
  });
  it("classifies backend tasks", () => {
    const domains = classifyTask(
      "Add a Postgres-backed REST API endpoint with rate limiting and a Redis cache",
    );
    expect(domains).toContain("backend");
  });
  it("classifies architecture tasks", () => {
    const domains = classifyTask(
      "Design the microservice boundary and event-driven flow between services",
    );
    expect(domains).toContain("architecture");
  });
  it("co-classifies UX with frontend", () => {
    const domains = classifyTask(
      "Improve the accessibility of the modal focus trap",
    );
    expect(domains).toContain("frontend");
    expect(domains).toContain("ux");
  });
  it("returns general for empty input", () => {
    const domains = classifyTask("");
    expect(domains).toEqual(["general"]);
  });
  it("returns at most 2 primary domains plus co-occurrences", () => {
    const domains = classifyTask(
      "Add an integration test for the auth API endpoint",
    );
    expect(domains.length).toBeLessThanOrEqual(4);
    expect(domains).toContain("testing");
  });
});

describe("isSkeletonProfileMd", () => {
  it("treats heading-only bootstrap file as skeleton", () => {
    expect(isSkeletonProfileMd("# Profile\n")).toBe(true);
  });

  it("treats legacy Project line bootstrap as skeleton", () => {
    expect(
      isSkeletonProfileMd("# Profile\n\nProject: `/Users/foo/terax-ai`\n"),
    ).toBe(true);
  });

  it("treats boilerplate-only refined file as skeleton", () => {
    expect(
      isSkeletonProfileMd(
        "# Profile\n\nThis is the project's living profile.\nIt is updated autonomously from signals.\n",
      ),
    ).toBe(true);
  });

  it("treats files with preference bullets as real content", () => {
    expect(
      isSkeletonProfileMd(
        "# Profile\n\n# general\n\n- Prefer clean code. Confidence: 0.72\n",
      ),
    ).toBe(false);
  });

  it("treats split-reference bullets as real content", () => {
    expect(
      isSkeletonProfileMd(
        "# Profile\n\n# frontend\n\n- See .xterax/frontend/profile.md\n",
      ),
    ).toBe(false);
  });
});
