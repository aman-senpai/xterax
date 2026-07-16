import { describe, expect, it } from "vitest";
import {
  BUILTIN_AGENTS,
  acpAgentHandle,
  buildAcpHandleMap,
  expandWorkflow,
  findAgentByHandle,
  parseAgentMentions,
  resolveHandleToken,
  slugifyHandle,
  type AcpAgentRef,
  type Agent,
} from "./agents";

function custom(
  partial: Partial<Agent> & Pick<Agent, "id" | "handle" | "name">,
): Agent {
  return {
    description: "",
    instructions: "test",
    icon: "spark",
    builtIn: false,
    toolAllowlist: null,
    shellAllowlist: ["*"],
    workflow: [],
    modelId: null,
    thinkingLevel: null,
    ...partial,
  };
}

function acp(
  partial: Partial<AcpAgentRef> & Pick<AcpAgentRef, "id" | "name">,
): AcpAgentRef {
  return {
    command: "npx",
    args: [],
    env: {},
    enabled: true,
    ...partial,
  };
}

describe("resolveHandleToken", () => {
  it("maps aliases to canonical handles", () => {
    expect(resolveHandleToken("implement")).toBe("coder");
    expect(resolveHandleToken("design")).toBe("designer");
    expect(resolveHandleToken("review-agent")).toBe("reviewer");
    expect(resolveHandleToken("architect")).toBe("architect");
  });
});

describe("findAgentByHandle", () => {
  it("finds builtins by handle and alias", () => {
    expect(findAgentByHandle(BUILTIN_AGENTS, "architect")?.id).toBe(
      "builtin:architect",
    );
    expect(findAgentByHandle(BUILTIN_AGENTS, "implement")?.id).toBe(
      "builtin:coder",
    );
    expect(findAgentByHandle(BUILTIN_AGENTS, "verification")?.id).toBe(
      "builtin:verification",
    );
  });
});

describe("expandWorkflow", () => {
  it("returns the agent itself when workflow is empty", () => {
    const agent = BUILTIN_AGENTS.find((a) => a.handle === "architect")!;
    const r = expandWorkflow(BUILTIN_AGENTS, agent);
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s) => (s.kind === "local" ? s.agent.handle : s.handle))).toEqual([
      "architect",
    ]);
  });

  it("expands a workflow in order", () => {
    const meta = custom({
      id: "a-full",
      name: "Full",
      handle: "full-review",
      workflow: ["architect", "reviewer", "verification"],
    });
    const all = [...BUILTIN_AGENTS, meta];
    const r = expandWorkflow(all, meta);
    expect(r.error).toBeUndefined();
    expect(
      r.steps.map((s) => (s.kind === "local" ? s.agent.handle : s.handle)),
    ).toEqual(["architect", "reviewer", "verification"]);
  });

  it("expands workflow entries that point at ACP agents", () => {
    const claude = acp({ id: "cc1", name: "Claude Code" });
    const acpMap = buildAcpHandleMap([claude], BUILTIN_AGENTS);
    const meta = custom({
      id: "a-mix",
      name: "Mix",
      handle: "with-claude",
      workflow: ["architect", "claude-code"],
    });
    // ensure handle matches map
    expect(acpMap.has("claude-code")).toBe(true);
    const r = expandWorkflow([...BUILTIN_AGENTS, meta], meta, {
      acpByHandle: acpMap,
    });
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s) => s.kind)).toEqual(["local", "acp"]);
    expect(r.steps[1].kind === "acp" && r.steps[1].handle).toBe("claude-code");
  });

  it("detects cycles", () => {
    const a = custom({
      id: "a1",
      name: "A",
      handle: "alpha",
      workflow: ["beta"],
    });
    const b = custom({
      id: "a2",
      name: "B",
      handle: "beta",
      workflow: ["alpha"],
    });
    const r = expandWorkflow([a, b], a);
    expect(r.error).toMatch(/cycle/i);
    expect(r.steps).toEqual([]);
  });
});

describe("parseAgentMentions", () => {
  it("parses ordered chips and strips them from the body", () => {
    const text =
      "[agent:reviewer] [agent:architect] [agent:implement] [agent:verification] fix the auth flow";
    const r = parseAgentMentions(text, BUILTIN_AGENTS);
    expect(r.error).toBeUndefined();
    expect(
      r.steps.map((s) => (s.kind === "local" ? s.agent.handle : s.handle)),
    ).toEqual(["reviewer", "architect", "coder", "verification"]);
    expect(r.body).toBe("fix the auth flow");
  });

  it("parses bare @handles in order", () => {
    const text = "@architect @coder ship the feature";
    const r = parseAgentMentions(text, BUILTIN_AGENTS);
    expect(
      r.steps.map((s) => (s.kind === "local" ? s.agent.handle : s.handle)),
    ).toEqual(["architect", "coder"]);
    expect(r.body).toBe("ship the feature");
  });

  it("parses ACP agents alongside local", () => {
    const claude = acp({ id: "cc1", name: "Claude Code" });
    const text = "@architect @claude-code verify this";
    const r = parseAgentMentions(text, BUILTIN_AGENTS, [claude]);
    expect(r.error).toBeUndefined();
    expect(r.steps.map((s) => s.kind)).toEqual(["local", "acp"]);
    expect(r.steps[1].kind === "acp" && r.steps[1].config.name).toBe(
      "Claude Code",
    );
    expect(r.body).toBe("verify this");
  });

  it("leaves unknown @tokens in the body", () => {
    const text = "ping @not-an-agent please";
    const r = parseAgentMentions(text, BUILTIN_AGENTS);
    expect(r.steps).toEqual([]);
    expect(r.body).toContain("@not-an-agent");
  });

  it("does not treat file [@name] chips as agent mentions", () => {
    const text = "[@README.md] please summarize";
    const r = parseAgentMentions(text, BUILTIN_AGENTS);
    expect(r.steps).toEqual([]);
    expect(r.body).toContain("[@README.md]");
  });
});

describe("acpAgentHandle", () => {
  it("slugifies ACP names", () => {
    expect(acpAgentHandle(acp({ id: "x", name: "Claude Code" }))).toBe(
      "claude-code",
    );
  });

  it("avoids reserved local handles", () => {
    const reserved = new Set(["coder"]);
    expect(
      acpAgentHandle(acp({ id: "xyz", name: "Coder" }), reserved),
    ).not.toBe("coder");
  });
});

describe("slugifyHandle", () => {
  it("slugifies names", () => {
    expect(slugifyHandle("My Cool Agent")).toBe("my-cool-agent");
  });
});
