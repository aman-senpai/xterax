/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  domToTextOffset,
  editorToText,
  getCaretOffset,
  getChipTextRanges,
  handleChipArrowNav,
  insertAgentChip,
  insertFileChip,
  refreshPipelineKeywordHighlights,
  setCaretOffset,
  textOffsetToDom,
} from "./contenteditable";

function makeEditor(initial = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.contentEditable = "true";
  if (initial) {
    el.appendChild(document.createTextNode(initial));
  }
  document.body.appendChild(el);
  return el;
}

function placeRootCaret(root: HTMLElement, childIndex: number) {
  const sel = window.getSelection();
  if (!sel) throw new Error("no selection");
  const range = document.createRange();
  if (childIndex >= root.childNodes.length) {
    if (root.lastChild) range.setStartAfter(root.lastChild);
    else range.setStart(root, 0);
  } else {
    range.setStart(root, childIndex);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

describe("contenteditable caret + chips", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = makeEditor();
  });

  afterEach(() => {
    root.remove();
  });

  it("maps root-level selection (child index) to the correct plain-text offset", () => {
    root.appendChild(document.createTextNode("hi "));
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.chip = "agent";
    chip.dataset.name = "coder";
    chip.textContent = "@coder";
    root.appendChild(chip);
    root.appendChild(document.createTextNode(" "));

    // Before chip (index 1)
    expect(domToTextOffset(root, root, 1)).toBe("hi ".length);
    // After chip (index 2)
    expect(domToTextOffset(root, root, 2)).toBe(
      "hi ".length + "[agent:coder]".length,
    );
    // End
    expect(domToTextOffset(root, root, 3)).toBe(
      "hi ".length + "[agent:coder]".length + 1,
    );
  });

  it("textOffsetToDom places after-chip offset in the trailing text node", () => {
    root.appendChild(document.createTextNode(""));
    const after = insertAgentChip(root, 0, 0, "coder");
    const text = editorToText(root);
    expect(text).toBe("[agent:coder] ");
    expect(after).toBe(text.length);

    const pos = textOffsetToDom(root, after);
    expect(pos).not.toBeNull();
    if (!pos) return;
    expect(pos.node.nodeType).toBe(Node.TEXT_NODE);
    expect(pos.offset).toBe(1);
  });

  it("setCaretOffset / getCaretOffset round-trip across an agent chip", () => {
    root.appendChild(document.createTextNode("@x"));
    const after = insertAgentChip(root, 0, 2, "architect");
    const total = editorToText(root).length;

    for (const offset of [0, after, total, Math.max(0, after - 1)]) {
      setCaretOffset(root, offset);
      expect(getCaretOffset(root)).toBe(offset);
    }

    // Explicitly before chip (root child index of the chip)
    const chip = root.querySelector("[data-chip=agent]");
    expect(chip).toBeTruthy();
    if (!chip) return;
    const chipIndex = Array.from(root.childNodes).indexOf(chip);
    placeRootCaret(root, chipIndex);
    expect(getCaretOffset(root)).toBe(0);

    // Root caret after chip
    placeRootCaret(root, chipIndex + 1);
    expect(getCaretOffset(root)).toBe("[agent:architect]".length);
  });

  it("does not fling caret to the end after insert + pipeline highlight refresh", () => {
    root.appendChild(document.createTextNode("@coder"));
    const after = insertAgentChip(root, 0, 6, "coder");
    // insertAgentChip already places the caret after the trailing space
    expect(getCaretOffset(root)).toBe(after);

    refreshPipelineKeywordHighlights(root);
    expect(getCaretOffset(root)).toBe(after);
    expect(getCaretOffset(root)).not.toBe(0);
  });

  it("handleChipArrowNav jumps over agent chips", () => {
    root.appendChild(document.createTextNode("a"));
    insertAgentChip(root, 1, 1, "coder");
    // DOM: "a" + chip + " "
    const before = "a".length;
    const after = before + "[agent:coder]".length;

    setCaretOffset(root, before);
    expect(handleChipArrowNav(root, "ArrowRight")).toBe(true);
    expect(getCaretOffset(root)).toBe(after);

    expect(handleChipArrowNav(root, "ArrowLeft")).toBe(true);
    expect(getCaretOffset(root)).toBe(before);

    // Mid-text: no jump
    setCaretOffset(root, 0);
    expect(handleChipArrowNav(root, "ArrowRight")).toBe(false);
  });

  it("getChipTextRanges reports agent and file chips", () => {
    root.appendChild(document.createTextNode("x"));
    insertAgentChip(root, 1, 1, "coder");
    const t = editorToText(root);
    const end = t.length;
    root.appendChild(document.createTextNode("@f"));
    insertFileChip(root, end, end + 2, "a.ts");

    const ranges = getChipTextRanges(root);
    expect(ranges.length).toBe(2);
    expect(ranges[0]).toEqual({
      start: 1,
      end: 1 + "[agent:coder]".length,
    });
    const first = ranges[0];
    expect(first).toBeTruthy();
    if (!first) return;
    expect(editorToText(root).slice(first.start, first.end)).toBe(
      "[agent:coder]",
    );
  });

  it("caret inside chip maps to a chip edge, not document end", () => {
    insertAgentChip(root, 0, 0, "coder");
    const chip = root.querySelector("[data-chip=agent]");
    expect(chip).toBeInstanceOf(HTMLElement);
    if (!(chip instanceof HTMLElement)) return;

    const sel = window.getSelection();
    expect(sel).toBeTruthy();
    if (!sel) return;

    const inner = chip.firstChild ?? chip;
    const range = document.createRange();
    if (inner.nodeType === Node.TEXT_NODE) {
      range.setStart(inner, 0);
    } else if (inner instanceof HTMLElement && inner.firstChild) {
      range.setStart(inner.firstChild, 0);
    } else {
      range.setStart(chip, 0);
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    const off = getCaretOffset(root);
    const total = editorToText(root).length;
    expect(off).toBeLessThan(total);
    expect(off === 0 || off === "[agent:coder]".length).toBe(true);
  });
});
