import { afterEach, describe, expect, it } from "vitest";
import {
  anchorProjectRoot,
  getAnchoredProjectRoot,
  resetAnchoredProjectRoot,
} from "./projectRoot";

describe("anchorProjectRoot", () => {
  afterEach(() => {
    resetAnchoredProjectRoot();
  });

  it("latches the first non-null root", () => {
    expect(anchorProjectRoot("/home/me/project")).toBe("/home/me/project");
    expect(getAnchoredProjectRoot()).toBe("/home/me/project");
  });

  it("ignores subsequent nulls once anchored", () => {
    anchorProjectRoot("/home/me/project");
    expect(anchorProjectRoot(null)).toBe("/home/me/project");
    expect(anchorProjectRoot("/home/me/other")).toBe("/home/me/project");
  });

  it("returns null until a non-null root is provided", () => {
    expect(anchorProjectRoot(null)).toBeNull();
    expect(getAnchoredProjectRoot()).toBeNull();
  });

  it("reset clears the anchor", () => {
    anchorProjectRoot("/home/me/project");
    resetAnchoredProjectRoot();
    expect(getAnchoredProjectRoot()).toBeNull();
    expect(anchorProjectRoot("/home/me/other")).toBe("/home/me/other");
  });
});
