import { describe, expect, it } from "vitest";
import {
  isNoisePreference,
  isSyntheticObservationMessage,
  isXteraxProfilePath,
} from "./signalNoise";

describe("signalNoise", () => {
  it("detects synthetic fs-watcher observation messages", () => {
    expect(
      isSyntheticObservationMessage(
        "User edited /Users/senpai/Developer/terax-ai/.xterax: user edited file",
      ),
    ).toBe(true);
  });

  it("does not flag normal user chat as synthetic", () => {
    expect(isSyntheticObservationMessage("Mujhe clean code pasand hai")).toBe(
      false,
    );
  });

  it("treats User edited paths as noise preferences", () => {
    expect(
      isNoisePreference(
        "User edited /Users/senpai/Developer/terax-ai/.xterax: user edited file",
      ),
    ).toBe(true);
  });

  it("matches .xterax directory and nested profile paths", () => {
    expect(isXteraxProfilePath("/proj/.xterax")).toBe(true);
    expect(isXteraxProfilePath("/proj/.xterax/profile.md")).toBe(true);
    expect(isXteraxProfilePath("/proj/.xterax/code-quality/profile.md")).toBe(
      true,
    );
    expect(isXteraxProfilePath("/proj/src/foo.ts")).toBe(false);
  });
});