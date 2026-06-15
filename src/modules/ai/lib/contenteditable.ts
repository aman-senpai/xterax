/**
 * Contenteditable helpers for inline chip rendering.
 *
 * The editor DOM consists of text nodes alternating with chip <span> elements
 * (contenteditable="false"). The "plain text" representation uses bracket
 * markers: [@filename] for files, [#handle] for snippets.
 */

export const CHIP_FILE_RE = /\[@([^\]]+)\]/;
export const CHIP_SNIPPET_RE = /\[#([^\]]+)\]/;

/** Build a plain-text representation from the editor's DOM. */
export function editorToText(root: HTMLElement): string {
  const parts: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent ?? "");
    } else if (child instanceof HTMLElement && child.dataset.chip === "file") {
      parts.push(`[@${child.dataset.name ?? "file"}]`);
    } else if (child instanceof HTMLElement && child.dataset.chip === "snippet") {
      parts.push(`[#${child.dataset.name ?? "snippet"}]`);
    } else if (child instanceof HTMLElement && child.dataset.chip === "command") {
      parts.push(`[/${child.dataset.name ?? "cmd"}]`);
    } else if (child instanceof HTMLElement && child.dataset.ghost !== undefined) {
      // Ghost text — skip entirely (not real content).
    } else if (child instanceof HTMLElement) {
      // Unknown element — fall back to text
      parts.push(child.textContent ?? "");
    } else {
      parts.push(child.textContent ?? "");
    }
  }
  return parts.join("");
}

/** Map a character offset in plain text to a DOM position inside `root`. */
export function textOffsetToDom(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } | null {
  let remaining = targetOffset;
  for (const child of Array.from(root.childNodes)) {
    const len = nodeTextLen(child);
    if (remaining <= len) {
      if (child.nodeType === Node.TEXT_NODE) {
        return { node: child, offset: Math.min(remaining, child.textContent?.length ?? 0) };
      }
      // Chip element — place before it
      return { node: root, offset: Array.from(root.childNodes).indexOf(child) };
    }
    remaining -= len;
  }
  // Past the end — place after last child
  const last = root.lastChild;
  if (last) {
    if (last.nodeType === Node.TEXT_NODE) {
      return { node: last, offset: last.textContent?.length ?? 0 };
    }
    return { node: root, offset: root.childNodes.length };
  }
  return { node: root, offset: 0 };
}

/** Map a DOM position to a character offset in plain text. */
export function domToTextOffset(root: HTMLElement, node: Node, offset: number): number {
  let pos = 0;
  for (const child of Array.from(root.childNodes)) {
    if (child === node) {
      return pos + Math.min(offset, child.nodeType === Node.TEXT_NODE ? (child.textContent?.length ?? 0) : 0);
    }
    pos += nodeTextLen(child);
  }
  // Node not found — return total length
  return pos;
}

/** Get the cursor position as a character offset in the editor. */
export function getCaretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return 0;
  return domToTextOffset(root, range.startContainer, range.startOffset);
}

/** Set cursor to a character offset in the editor. */
export function setCaretOffset(root: HTMLElement, offset: number) {
  const pos = textOffsetToDom(root, offset);
  if (!pos) return;
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (pos.node === root) {
    const child = root.childNodes[pos.offset];
    if (child) {
      range.setStartBefore(child);
      range.collapse(true);
    } else {
      range.setStartAfter(root.lastChild || root);
      range.collapse(true);
    }
  } else {
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Replace the text range [start..end] in the editor with a file chip <span>.
 * Assumes the range is within text nodes (no chip boundaries).
 * Returns the final cursor offset (positioned right after the chip).
 */
export function insertFileChip(
  root: HTMLElement,
  start: number,
  end: number,
  fileName: string,
  _onRemove?: () => void,
): number {
  const chip = document.createElement("span");
  chip.setAttribute("contenteditable", "false");
  chip.dataset.chip = "file";
  chip.dataset.name = fileName;
  chip.className =
    "inline-flex items-center gap-0.5 px-1 rounded align-middle select-none cursor-default text-[11px] bg-accent text-accent-foreground font-medium";
  chip.innerHTML = `<span class="opacity-60 text-[10px]">@</span>${escapeHtml(fileName)}`;

  deleteRangeInsertNode(root, start, end, chip);
  // Cursor goes after the chip — the chip text length plus one for the
  // mandatory trailing space that keeps the caret operable.
  return start + `[@${fileName}]`.length + 1;
}

/**
 * Replace the text range [start..end] with a snippet chip.
 */
export function insertSnippetChip(
  root: HTMLElement,
  start: number,
  end: number,
  handle: string,
  _onRemove?: () => void,
): number {
  const chip = document.createElement("span");
  chip.setAttribute("contenteditable", "false");
  chip.dataset.chip = "snippet";
  chip.dataset.name = handle;
  chip.className =
    "inline-flex items-center gap-0.5 px-1 rounded align-middle select-none cursor-default text-[11px] bg-primary/15 text-primary font-medium";
  chip.innerHTML = `<span class="opacity-60 text-[10px]">#</span>${escapeHtml(handle)}`;

  deleteRangeInsertNode(root, start, end, chip);
  return start + `[#${handle}]`.length + 1;
}

/** Delete text in [start..end] and insert a single node in its place. */
function deleteRangeInsertNode(
  root: HTMLElement,
  start: number,
  end: number,
  node: HTMLElement,
) {
  const range = document.createRange();
  const startPos = textOffsetToDom(root, start);
  const endPos = textOffsetToDom(root, end);
  if (!startPos || !endPos) return;

  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  range.deleteContents();
  range.insertNode(node);

  // Ensure there's a text node after the chip so typing continues naturally
  const next = node.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) {
    const space = document.createTextNode(" ");
    node.parentNode?.insertBefore(space, node.nextSibling);
  }
}

/** Build a plain-text only version (strip chip markers) for submit. */
export function editorToSubmitText(root: HTMLElement): string {
  const parts: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent ?? "");
    }
    // Chips are omitted from submit text — the AI gets file content separately
  }
  return parts.join("");
}

/** Insert plain text at the current cursor position. */
export function insertTextAtCaret(_root: HTMLElement, text: string) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  range.insertNode(document.createTextNode(text));
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function nodeTextLen(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.length ?? 0;
  }
  if (node instanceof HTMLElement && node.dataset.ghost !== undefined) {
    // Ghost text — skip entirely (not real content).
    return 0;
  }
  if (node instanceof HTMLElement && node.dataset.chip === "file") {
    return `[@${node.dataset.name ?? "file"}]`.length;
  }
  if (node instanceof HTMLElement && node.dataset.chip === "snippet") {
    return `[#${node.dataset.name ?? "snippet"}]`.length;
  }
  if (node instanceof HTMLElement && node.dataset.chip === "command") {
    return `[/${node.dataset.name ?? "cmd"}]`.length;
  }
  return node.textContent?.length ?? 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Expose for use by picker handlers. */
export type EditorChipMeta =
  | { kind: "file"; name: string }
  | { kind: "snippet"; handle: string }
  | { kind: "command"; name: string };
