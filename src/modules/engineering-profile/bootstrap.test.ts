import { describe, expect, it } from "vitest";
import { bootstrapPath } from "./bootstrap";

describe("bootstrapPath", () => {
  it("uses .terax/ at the workspace root", () => {
    expect(bootstrapPath("/home/me/project")).toBe("/home/me/project/.terax");
  });
  it("strips a trailing slash from the workspace root", () => {
    expect(bootstrapPath("/home/me/project/")).toBe("/home/me/project/.terax");
  });
  it("handles Windows-style backslashes by preserving them as-is", () => {
    expect(bootstrapPath("C:\\Users\\me\\project")).toBe(
      "C:\\Users\\me\\project/.terax",
    );
  });
});
