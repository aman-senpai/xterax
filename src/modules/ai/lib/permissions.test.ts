import { beforeEach, describe, expect, it, vi } from "vitest";

const { getStateMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: { getState: getStateMock },
}));

vi.mock("../store/agentsStore", () => ({
  useAgentsStore: {
    getState: () => ({
      activeId: "builtin:xterax",
      all: () => [
        {
          id: "builtin:xterax",
          name: "Xterax",
          handle: "xterax",
          description: "",
          instructions: "",
          icon: "spark",
          builtIn: true,
          toolAllowlist: null,
          shellAllowlist: ["*"],
          workflow: [],
          modelId: null,
          thinkingLevel: null,
        },
      ],
    }),
  },
}));

vi.mock("../store/modesStore", () => ({
  getActiveMode: () => ({
    id: "builtin:default",
    name: "Default",
    description: "",
    instructions: "",
    toolAllowlist: null,
    enablePlanMode: false,
    permissionMode: null,
    builtIn: true,
  }),
}));

import {
  hasShellMetacharacters,
  isPathInWritableDirectories,
  isToolAllowedByAgent,
  matchShellAllowlistPattern,
  resolveToolPolicy,
} from "./permissions";
import type { Agent } from "./agents";

function setPerms(partial: {
  toolPermissions?: Record<string, string>;
  shellAllowlist?: { pattern: string; enabled: boolean }[];
  writableDirectories?: string[];
}) {
  getStateMock.mockReturnValue({
    permissions: {
      toolPermissions: {
        bash_run: "ask",
        bash_background: "ask",
        write_file: "ask",
        edit: "ask",
        multi_edit: "ask",
        create_directory: "ask",
        spawn_coding_agent: "ask",
        send_to_agent: "ask",
        ...partial.toolPermissions,
      },
      shellAllowlist: partial.shellAllowlist ?? [],
      writableDirectories: partial.writableDirectories ?? [],
    },
  });
}

const freeAgent: Agent = {
  id: "a",
  name: "A",
  handle: "a",
  description: "",
  instructions: "",
  icon: "spark",
  builtIn: false,
  toolAllowlist: null,
  shellAllowlist: ["*"],
  workflow: [],
  modelId: null,
  thinkingLevel: null,
};

describe("matchShellAllowlistPattern", () => {
  it("matches exact commands", () => {
    expect(matchShellAllowlistPattern("npm test", "npm test")).toBe(true);
  });

  it("matches safe globs", () => {
    expect(matchShellAllowlistPattern("npm run build", "npm run *")).toBe(true);
    expect(matchShellAllowlistPattern("cargo test", "cargo *")).toBe(true);
  });

  it("refuses glob match when command has shell metacharacters", () => {
    expect(
      matchShellAllowlistPattern("npm run build; rm -rf /", "npm run *"),
    ).toBe(false);
    expect(
      matchShellAllowlistPattern("npm run build && rm -rf ~", "npm run *"),
    ).toBe(false);
    expect(matchShellAllowlistPattern("npm run x | sh", "npm run *")).toBe(
      false,
    );
    expect(
      matchShellAllowlistPattern("npm run $(evil)", "npm run *"),
    ).toBe(false);
  });

  it("allows exact match even with metacharacters", () => {
    const cmd = "echo a && echo b";
    expect(matchShellAllowlistPattern(cmd, cmd)).toBe(true);
  });
});

describe("hasShellMetacharacters", () => {
  it("detects chaining", () => {
    expect(hasShellMetacharacters("a; b")).toBe(true);
    expect(hasShellMetacharacters("a | b")).toBe(true);
    expect(hasShellMetacharacters("a && b")).toBe(true);
    expect(hasShellMetacharacters("ls")).toBe(false);
  });
});

describe("resolveToolPolicy", () => {
  beforeEach(() => {
    setPerms({});
  });

  it("honors session auto-approve and read-only", () => {
    expect(resolveToolPolicy("bash_run", "auto-approve", {}, freeAgent)).toBe(
      "auto-approve",
    );
    expect(resolveToolPolicy("bash_run", "read-only", {}, freeAgent)).toBe(
      "deny",
    );
    expect(resolveToolPolicy("read_file", "read-only", {}, freeAgent)).toBe(
      "auto-approve",
    );
    expect(
      resolveToolPolicy("mcp__server__tool", "read-only", {}, freeAgent),
    ).toBe("deny");
  });

  it("auto-approves writes under writableDirectories", () => {
    setPerms({ writableDirectories: ["/home/me/project/src"] });
    expect(
      resolveToolPolicy(
        "write_file",
        "default",
        { path: "/home/me/project/src/foo.ts" },
        freeAgent,
      ),
    ).toBe("auto-approve");
    expect(
      resolveToolPolicy(
        "write_file",
        "default",
        { path: "/home/me/other/foo.ts" },
        freeAgent,
      ),
    ).toBe("ask");
  });

  it("auto-approves shell via safe allowlist only", () => {
    setPerms({
      shellAllowlist: [{ pattern: "npm run *", enabled: true }],
    });
    expect(
      resolveToolPolicy(
        "bash_run",
        "default",
        { command: "npm run test" },
        freeAgent,
      ),
    ).toBe("auto-approve");
    expect(
      resolveToolPolicy(
        "bash_run",
        "default",
        { command: "npm run test; cat /etc/passwd" },
        freeAgent,
      ),
    ).toBe("ask");
  });

  it("denies tools outside agent toolAllowlist", () => {
    const restricted: Agent = {
      ...freeAgent,
      toolAllowlist: ["fs", "search"],
    };
    expect(resolveToolPolicy("bash_run", "default", {}, restricted)).toBe(
      "deny",
    );
    expect(resolveToolPolicy("read_file", "default", {}, restricted)).toBe(
      "auto-approve",
    );
  });

  it("asks for MCP tools in default mode", () => {
    expect(
      resolveToolPolicy("mcp__github__create_issue", "default", {}, freeAgent),
    ).toBe("ask");
  });

  it("honors per-tool deny", () => {
    setPerms({ toolPermissions: { write_file: "deny" } });
    expect(
      resolveToolPolicy(
        "write_file",
        "default",
        { path: "/tmp/x" },
        freeAgent,
      ),
    ).toBe("deny");
  });
});

describe("isToolAllowedByAgent", () => {
  it("allows all when null", () => {
    expect(isToolAllowedByAgent("bash_run", null)).toBe(true);
  });

  it("expands groups", () => {
    expect(isToolAllowedByAgent("edit", ["edit"])).toBe(true);
    expect(isToolAllowedByAgent("write_file", ["edit"])).toBe(false);
    expect(isToolAllowedByAgent("write_file", ["fs"])).toBe(true);
  });

  it("matches mcp wildcards", () => {
    expect(isToolAllowedByAgent("mcp__foo__bar", ["mcp__*"])).toBe(true);
    expect(isToolAllowedByAgent("bash_run", ["mcp__*"])).toBe(false);
  });
});

describe("isPathInWritableDirectories", () => {
  it("matches descendants", () => {
    setPerms({ writableDirectories: ["/proj/src"] });
    expect(isPathInWritableDirectories("/proj/src/a.ts")).toBe(true);
    expect(isPathInWritableDirectories("/proj/src")).toBe(true);
    expect(isPathInWritableDirectories("/proj/other")).toBe(false);
  });
});
