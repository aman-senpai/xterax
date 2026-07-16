import { describe, expect, it } from "vitest";
import { appendUserText, applyAcpUpdate } from "./mapUpdates";
import type { AcpTranscriptMessage } from "./types";

describe("applyAcpUpdate", () => {
  it("streams agent message chunks into one assistant message", () => {
    let msgs: AcpTranscriptMessage[] = [];
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " world" },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].parts[0]).toEqual({ type: "text", text: "Hello world" });
  });

  it("creates tool call parts and updates status", () => {
    let msgs = appendUserText([], "do it");
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Read file",
      kind: "read",
      status: "pending",
    });
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
    });
    const tool = msgs
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool" && p.toolCallId === "c1");
    expect(tool).toMatchObject({ type: "tool", status: "completed" });
  });

  it("replaces plan entries", () => {
    let msgs: AcpTranscriptMessage[] = [];
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "plan",
      entries: [{ content: "step 1", status: "pending" }],
    });
    msgs = applyAcpUpdate(msgs, {
      sessionUpdate: "plan",
      entries: [
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "pending" },
      ],
    });
    const plan = msgs[0].parts.find((p) => p.type === "plan");
    expect(plan?.type).toBe("plan");
    if (plan?.type === "plan") {
      expect(plan.entries).toHaveLength(2);
    }
  });
});
