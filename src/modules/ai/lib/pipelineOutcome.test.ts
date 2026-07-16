import { describe, expect, it } from "vitest";
import {
  extractPipelineSignal,
  formatLoopBreakNote,
  resolveBodyOutcome,
  shouldBreakLoop,
} from "./pipelineOutcome";

describe("extractPipelineSignal", () => {
  it("returns null without a machine line", () => {
    expect(extractPipelineSignal("All tests passed. Looks good.")).toBeNull();
    expect(extractPipelineSignal("")).toBeNull();
  });

  it("parses PIPELINE_OUTCOME", () => {
    expect(
      extractPipelineSignal("done.\nPIPELINE_OUTCOME: pass\n"),
    ).toMatchObject({ signal: "pass" });
    expect(extractPipelineSignal("PIPELINE_OUTCOME: fail")).toMatchObject({
      signal: "fail",
    });
    expect(extractPipelineSignal("PIPELINE_OUTCOME: continue")).toMatchObject({
      signal: "continue",
    });
  });

  it("accepts aliases and last-wins", () => {
    expect(extractPipelineSignal("PIPELINE_BREAK: pass")).toMatchObject({
      signal: "pass",
    });
    expect(extractPipelineSignal("PIPELINE_BREAK: ok")).toMatchObject({
      signal: "pass",
    });
    expect(extractPipelineSignal("PIPELINE_BREAK: done")).toMatchObject({
      signal: "pass",
    });
    expect(
      extractPipelineSignal(
        "PIPELINE_OUTCOME: pass\nmore text\nPIPELINE_OUTCOME: fail",
      ),
    ).toMatchObject({ signal: "fail" });
    expect(extractPipelineSignal("<<<PIPELINE_OUTCOME:pass>>>")).toMatchObject({
      signal: "pass",
    });
  });

  it("ignores prose that only looks like success", () => {
    expect(
      extractPipelineSignal(
        "All tests passed. Verification succeeded. Looks good. LGTM.",
      ),
    ).toBeNull();
  });
});

describe("resolveBodyOutcome", () => {
  it("prefers last explicit signal in body order", () => {
    const o = resolveBodyOutcome([
      {
        handle: "coder",
        status: "done",
        summary: "implemented\nPIPELINE_OUTCOME: continue",
      },
      {
        handle: "verification",
        status: "done",
        summary: "green\nPIPELINE_OUTCOME: pass",
      },
    ]);
    expect(o).toMatchObject({
      kind: "pass",
      sourceHandle: "verification",
      reason: "explicit_signal",
    });
  });

  it("scans reverse so earlier signals lose", () => {
    const o = resolveBodyOutcome([
      {
        handle: "verification",
        status: "done",
        summary: "PIPELINE_OUTCOME: pass",
      },
      {
        handle: "coder",
        status: "done",
        summary: "PIPELINE_OUTCOME: continue",
      },
    ]);
    expect(o.kind).toBe("continue");
    expect(o.sourceHandle).toBe("coder");
  });

  it("maps step error without signal to fail", () => {
    const o = resolveBodyOutcome([
      { handle: "coder", status: "error", summary: "tool exploded" },
    ]);
    expect(o).toMatchObject({
      kind: "fail",
      reason: "step_error",
      sourceHandle: "coder",
    });
  });

  it("explicit signal overrides prior error when later", () => {
    const o = resolveBodyOutcome([
      { handle: "coder", status: "error", summary: "boom" },
      {
        handle: "verification",
        status: "done",
        summary: "PIPELINE_OUTCOME: pass",
      },
    ]);
    expect(o.kind).toBe("pass");
  });

  it("user abort wins", () => {
    const o = resolveBodyOutcome([
      {
        handle: "coder",
        status: "aborted",
        summary: "PIPELINE_OUTCOME: pass",
      },
    ]);
    expect(o.kind).toBe("aborted");
    expect(o.reason).toBe("user_abort");
  });

  it("unknown when done without signal", () => {
    const o = resolveBodyOutcome([
      { handle: "coder", status: "done", summary: "I fixed it, all good" },
    ]);
    expect(o).toMatchObject({ kind: "unknown", reason: "no_signal" });
  });
});

describe("shouldBreakLoop", () => {
  const pass = {
    kind: "pass" as const,
    sourceHandle: "v",
    reason: "explicit_signal" as const,
    signalLine: "PIPELINE_OUTCOME: pass",
  };
  const fail = {
    kind: "fail" as const,
    sourceHandle: "v",
    reason: "explicit_signal" as const,
    signalLine: "PIPELINE_OUTCOME: fail",
  };
  const cont = {
    kind: "continue" as const,
    sourceHandle: "c",
    reason: "explicit_signal" as const,
    signalLine: "PIPELINE_OUTCOME: continue",
  };
  const unknown = {
    kind: "unknown" as const,
    sourceHandle: null,
    reason: "no_signal" as const,
    signalLine: null,
  };

  it("null / never never break", () => {
    expect(shouldBreakLoop(null, pass)).toBe(false);
    expect(shouldBreakLoop("never", pass)).toBe(false);
  });

  it("always breaks", () => {
    expect(shouldBreakLoop("always", unknown)).toBe(true);
    expect(shouldBreakLoop("always", fail)).toBe(true);
  });

  it("pass / done only on pass outcome", () => {
    expect(shouldBreakLoop("pass", pass)).toBe(true);
    expect(shouldBreakLoop("done", pass)).toBe(true);
    expect(shouldBreakLoop("pass", fail)).toBe(false);
    expect(shouldBreakLoop("pass", cont)).toBe(false);
    expect(shouldBreakLoop("pass", unknown)).toBe(false);
  });

  it("fail only on fail outcome", () => {
    expect(shouldBreakLoop("fail", fail)).toBe(true);
    expect(shouldBreakLoop("fail", pass)).toBe(false);
    expect(shouldBreakLoop("fail", unknown)).toBe(false);
  });
});

describe("formatLoopBreakNote", () => {
  it("describes break and max", () => {
    const outcome = {
      kind: "pass" as const,
      sourceHandle: "verification",
      reason: "explicit_signal" as const,
      signalLine: "PIPELINE_OUTCOME: pass",
    };
    expect(
      formatLoopBreakNote({
        loopId: "L1",
        iter: 2,
        max: 3,
        breakWhen: "pass",
        outcome,
        broke: true,
        atMax: false,
      }),
    ).toContain("Broke L1 after iter 2/3");
    expect(
      formatLoopBreakNote({
        loopId: "L1",
        iter: 3,
        max: 3,
        breakWhen: "pass",
        outcome,
        broke: false,
        atMax: true,
      }),
    ).toContain("Finished L1 at max 3");
  });
});
