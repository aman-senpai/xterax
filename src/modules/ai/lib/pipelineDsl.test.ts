import { describe, expect, it } from "vitest";
import {
  formatLoopPreset,
  formatPipelineProgram,
  parsePipelineProgram,
} from "./pipelineDsl";
import { evaluateBreak } from "./pipelineOutcome";

describe("parsePipelineProgram", () => {
  it("parses simple sequential mentions", () => {
    const p = parsePipelineProgram(
      "@reviewer do a security review then @architect plan a fix",
    );
    expect(p).not.toBeNull();
    expect(p!.nodes.map((n) => (n.type === "agent" ? n.handle : "?"))).toEqual([
      "reviewer",
      "architect",
    ]);
    expect(p!.body.toLowerCase()).toContain("security review");
    expect(p!.body.toLowerCase()).toContain("plan a fix");
  });

  it("parses arrow chaining", () => {
    const p = parsePipelineProgram(
      "@architect -> @coder -> @verification ship it",
    );
    expect(
      p!.nodes.map((n) => (n.type === "agent" ? n.handle : n.type)),
    ).toEqual(["architect", "coder", "verification"]);
    expect(p!.body).toMatch(/ship it/i);
  });

  it("parses loop with break if pass", () => {
    const p = parsePipelineProgram(`
@architect design the cache
loop 3:
  @coder implement
  @verification
  break if pass
@reviewer final look
`);
    expect(p).not.toBeNull();
    expect(p!.nodes[0]).toMatchObject({ type: "agent", handle: "architect" });
    expect(p!.nodes[1]).toMatchObject({
      type: "loop",
      max: 3,
      breakWhen: "pass",
    });
    if (p!.nodes[1].type !== "loop") throw new Error("expected loop");
    expect(
      p!.nodes[1].body.map((n) => (n.type === "agent" ? n.handle : n.type)),
    ).toEqual(["coder", "verification"]);
    expect(p!.nodes[2]).toMatchObject({ type: "agent", handle: "reviewer" });
  });

  it("parses agent chips", () => {
    const p = parsePipelineProgram(
      "[agent:reviewer] check auth then [agent:coder] fix it",
    );
    expect(p!.handles).toEqual(["reviewer", "coder"]);
  });

  it("returns null without agents", () => {
    expect(parsePipelineProgram("just a normal question")).toBeNull();
  });

  it("bare loop uses default max; loop N sets iterations", () => {
    const a = parsePipelineProgram("loop:\n  @coder\n  break if done");
    expect(a!.nodes[0]).toMatchObject({
      type: "loop",
      max: 3,
      breakWhen: "done",
    });
    const b = parsePipelineProgram("loop 15:\n  @coder\n  break if fail");
    expect(b!.nodes[0]).toMatchObject({
      type: "loop",
      max: 8, // absolute default ceiling
      breakWhen: "fail",
    });
    const c = parsePipelineProgram("loop 2:\n  @coder\n  break if fail");
    expect(c!.nodes[0]).toMatchObject({
      type: "loop",
      max: 2,
      breakWhen: "fail",
    });
  });

  it("honors parse options for default and absolute max", () => {
    const bare = parsePipelineProgram("loop:\n  @coder", {
      defaultMax: 5,
      absoluteMax: 6,
    });
    expect(bare!.nodes[0]).toMatchObject({ type: "loop", max: 5 });

    const clamped = parsePipelineProgram("loop 99:\n  @coder", {
      defaultMax: 2,
      absoluteMax: 4,
    });
    expect(clamped!.nodes[0]).toMatchObject({ type: "loop", max: 4 });
  });
});

describe("evaluateBreak (structured only)", () => {
  it("honors machine signals only", () => {
    expect(evaluateBreak("pass", "All good.\nPIPELINE_OUTCOME: pass")).toBe(
      true,
    );
    expect(evaluateBreak("pass", "Still broken.\nPIPELINE_OUTCOME: fail")).toBe(
      false,
    );
    expect(evaluateBreak("fail", "PIPELINE_BREAK: fail")).toBe(true);
  });

  it("ignores natural language pass/fail", () => {
    expect(evaluateBreak("pass", "All tests passed. Verification ok.")).toBe(
      false,
    );
    expect(evaluateBreak("fail", "Verification failed.")).toBe(false);
  });

  it("handles always/never", () => {
    expect(evaluateBreak("always", "anything")).toBe(true);
    expect(evaluateBreak("never", "PIPELINE_OUTCOME: pass")).toBe(false);
    expect(evaluateBreak(null, "PIPELINE_OUTCOME: pass")).toBe(false);
  });
});

describe("formatPipelineProgram", () => {
  it("pretty prints loops", () => {
    const p = parsePipelineProgram(`
loop 2:
  @coder
  @verification
  break if pass
`);
    const s = formatPipelineProgram(p!.nodes);
    expect(s).toContain("loop 2:");
    expect(s).toContain("@coder");
    expect(s).toContain("break if pass");
  });
});

describe("formatLoopPreset", () => {
  it("expands a saved preset to DSL", () => {
    const s = formatLoopPreset({
      id: "1",
      handle: "implement-verify",
      name: "Implement & verify",
      description: "",
      max: 3,
      body: "@coder implement\n@verification\nbreak if pass",
    });
    expect(s).toBe(
      "loop 3:\n  @coder implement\n  @verification\n  break if pass",
    );
  });
});
