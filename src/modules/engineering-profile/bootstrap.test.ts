import { beforeEach, describe, expect, it, vi } from "vitest";

const { projectMirrorExistsMock, clearProjectDataMock } = vi.hoisted(() => ({
  projectMirrorExistsMock: vi.fn(),
  clearProjectDataMock: vi.fn(async () => {}),
}));

vi.mock("./storage", () => ({
  projectMirrorExists: projectMirrorExistsMock,
  clearProjectData: clearProjectDataMock,
}));

import { bootstrapPath, resetProjectStoreIfMirrorMissing } from "./bootstrap";

describe("resetProjectStoreIfMirrorMissing", () => {
  beforeEach(() => {
    projectMirrorExistsMock.mockReset();
    clearProjectDataMock.mockClear();
  });

  it("clears project store data when .xterax mirror is absent", async () => {
    projectMirrorExistsMock.mockResolvedValueOnce(false);
    await resetProjectStoreIfMirrorMissing("/home/me/project");
    expect(clearProjectDataMock).toHaveBeenCalledWith("/home/me/project");
  });

  it("does not clear store when mirror already exists", async () => {
    projectMirrorExistsMock.mockResolvedValueOnce(true);
    await resetProjectStoreIfMirrorMissing("/home/me/project");
    expect(clearProjectDataMock).not.toHaveBeenCalled();
  });
});

describe("bootstrapPath", () => {
  it("uses .xterax/ at the workspace root", () => {
    expect(bootstrapPath("/home/me/project")).toBe("/home/me/project/.xterax");
  });
  it("strips a trailing slash from the workspace root", () => {
    expect(bootstrapPath("/home/me/project/")).toBe("/home/me/project/.xterax");
  });
  it("handles Windows-style backslashes by preserving them as-is", () => {
    expect(bootstrapPath("C:\\Users\\me\\project")).toBe(
      "C:\\Users\\me\\project/.xterax",
    );
  });
});
