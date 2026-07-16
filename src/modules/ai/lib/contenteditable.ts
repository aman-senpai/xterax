/**
 * Contenteditable helpers for inline chip rendering.
 *
 * The editor DOM consists of text nodes alternating with chip <span> elements
 * (contenteditable="false"). The "plain text" representation uses bracket
 * markers: [@filename] for files, [#handle] for snippets, [agent:handle] for
 * agents.
 *
 * Caret math treats chips as atomic. The browser often parks the selection on
 * the editor root with a child index (between nodes) rather than inside a text
 * node — get/set helpers must round-trip that form correctly.
 */

export const CHIP_FILE_RE = /\[@([^\]]+)\]/;
export const CHIP_SNIPPET_RE = /\[#([^\]]+)\]/;

function isChipElement(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.dataset.chip === "file" ||
      node.dataset.chip === "snippet" ||
      node.dataset.chip === "agent" ||
      node.dataset.chip === "command")
  );
}

function isGhostElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.dataset.ghost !== undefined;
}

function isPipelineKwElement(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement && node.dataset.pipelineKw !== undefined
  );
}

/** Build a plain-text representation from the editor's DOM. */
export function editorToText(root: HTMLElement): string {
  const parts: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      parts.push(child.textContent ?? "");
    } else if (child instanceof HTMLElement && child.dataset.chip === "file") {
      parts.push(`[@${child.dataset.name ?? "file"}]`);
    } else if (
      child instanceof HTMLElement &&
      child.dataset.chip === "snippet"
    ) {
      parts.push(`[#${child.dataset.name ?? "snippet"}]`);
    } else if (child instanceof HTMLElement && child.dataset.chip === "agent") {
      // Distinct from file chips which also use [@name]
      parts.push(`[agent:${child.dataset.name ?? "agent"}]`);
    } else if (
      child instanceof HTMLElement &&
      child.dataset.chip === "command"
    ) {
      parts.push(`[/${child.dataset.name ?? "cmd"}]`);
    } else if (
      child instanceof HTMLElement &&
      child.dataset.pipelineKw !== undefined
    ) {
      // Keyword highlight span — plain text only
      parts.push(child.textContent ?? "");
    } else if (
      child instanceof HTMLElement &&
      child.dataset.ghost !== undefined
    ) {
      // Ghost text — skip entirely (not real content).
    } else if (child instanceof HTMLElement) {
      if (child.tagName === "BR") {
        parts.push("\n");
      } else {
        // Unknown element — fall back to its text (defensive)
        parts.push(child.textContent ?? "");
      }
    } else {
      parts.push(child.textContent ?? "");
    }
  }
  return parts.join("");
}

/**
 * Plain-text [start, end) ranges of every atomic chip under `root`.
 * Used for arrow-key skip and caret snap.
 */
export function getChipTextRanges(
  root: HTMLElement,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let pos = 0;
  for (const child of Array.from(root.childNodes)) {
    const len = nodeTextLen(child);
    if (isChipElement(child)) {
      ranges.push({ start: pos, end: pos + len });
    }
    pos += len;
  }
  return ranges;
}

/** Map a character offset in plain text to a DOM position inside `root`. */
export function textOffsetToDom(
  root: HTMLElement,
  targetOffset: number,
): { node: Node; offset: number } | null {
  let remaining = Math.max(0, targetOffset);
  const children = Array.from(root.childNodes);

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!child) continue;
    const len = nodeTextLen(child);

    if (child.nodeType === Node.TEXT_NODE) {
      if (remaining <= len) {
        return {
          node: child,
          offset: Math.min(remaining, child.textContent?.length ?? 0),
        };
      }
      remaining -= len;
      continue;
    }

    if (isGhostElement(child)) {
      // Zero-length in the plain-text model — never a caret target.
      continue;
    }

    if (isPipelineKwElement(child)) {
      if (remaining <= len) {
        const tn = child.firstChild;
        if (tn && tn.nodeType === Node.TEXT_NODE) {
          return {
            node: tn,
            offset: Math.min(remaining, tn.textContent?.length ?? 0),
          };
        }
        return { node: root, offset: i };
      }
      remaining -= len;
      continue;
    }

    if (isChipElement(child)) {
      // Atomic: offset at the start of the chip token → before the chip.
      // Offset at the end of the chip token (remaining === len when we enter)
      // falls through so the next sibling (usually a trailing space text node)
      // receives remaining === 0 — that is "after the chip".
      if (remaining === 0) {
        return { node: root, offset: i };
      }
      if (remaining < len) {
        // Mid-token: snap to the near edge (before).
        return { node: root, offset: i };
      }
      remaining -= len;
      continue;
    }

    // Unknown element — treat like a text blob / place before when landing inside.
    if (remaining <= len) {
      return { node: root, offset: i };
    }
    remaining -= len;
  }

  // Past the end — place after last child
  const last = root.lastChild;
  if (last) {
    if (last.nodeType === Node.TEXT_NODE) {
      return { node: last, offset: last.textContent?.length ?? 0 };
    }
    if (
      isPipelineKwElement(last) &&
      last.firstChild?.nodeType === Node.TEXT_NODE
    ) {
      const tn = last.firstChild;
      return { node: tn, offset: tn.textContent?.length ?? 0 };
    }
    return { node: root, offset: root.childNodes.length };
  }
  return { node: root, offset: 0 };
}

/** Map a DOM position to a character offset in plain text. */
export function domToTextOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
): number {
  // Selection parked on the editor root with a child index (between nodes).
  // This is the normal form after setStartBefore/setStartAfter on chips.
  if (node === root) {
    let pos = 0;
    const n = Math.min(Math.max(0, offset), root.childNodes.length);
    for (let i = 0; i < n; i++) {
      const child = root.childNodes[i];
      if (child) pos += nodeTextLen(child);
    }
    return pos;
  }

  let pos = 0;
  for (const child of Array.from(root.childNodes)) {
    if (child === node) {
      if (child.nodeType === Node.TEXT_NODE) {
        return (
          pos + Math.min(offset, child.textContent?.length ?? 0)
        );
      }
      // Element selected directly: offset is an index into its children.
      // Chips are atomic — 0 → before, anything else → after.
      if (isChipElement(child)) {
        return offset > 0 ? pos + nodeTextLen(child) : pos;
      }
      return pos;
    }

    // Caret inside a keyword span's text node
    if (
      isPipelineKwElement(child) &&
      (child === node || child.contains(node))
    ) {
      if (node.nodeType === Node.TEXT_NODE) {
        return pos + Math.min(offset, node.textContent?.length ?? 0);
      }
      return pos + nodeTextLen(child);
    }

    // Caret inside a contenteditable=false chip — treat as atomic.
    // Prefer "after" so Right-arrow / highlight restore can progress past the
    // chip instead of snapping forever to its leading edge. Only the very
    // first boundary (offset 0 on the chip or its first text child) maps to
    // "before".
    if (isChipElement(child) && child.contains(node)) {
      const atStart =
        (node === child && offset === 0) ||
        (node.nodeType === Node.TEXT_NODE &&
          offset === 0 &&
          (child.firstChild === node ||
            (child.firstChild instanceof HTMLElement &&
              child.firstChild.firstChild === node)));
      return atStart ? pos : pos + nodeTextLen(child);
    }

    // Ghost is zero-length; caret "inside" it maps to its attachment point.
    if (isGhostElement(child) && child.contains(node)) {
      return pos;
    }

    pos += nodeTextLen(child);
  }
  // Node not found — return total length
  return pos;
}

/** Get the cursor position as a character offset in the editor. */
export function getCaretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  // Inclusive: root.contains(root) is true; also accept caret on root itself.
  if (range.startContainer !== root && !root.contains(range.startContainer)) {
    return 0;
  }
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
      // Prefer the start of a following text node over a root-level boundary
      // when the caret should sit after a chip — more stable for typing.
      const prev =
        pos.offset > 0 ? root.childNodes[pos.offset - 1] : null;
      if (
        child.nodeType === Node.TEXT_NODE &&
        prev &&
        isChipElement(prev)
      ) {
        range.setStart(child, 0);
        range.collapse(true);
      } else {
        range.setStartBefore(child);
        range.collapse(true);
      }
    } else {
      const last = root.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) {
        range.setStart(last, last.textContent?.length ?? 0);
        range.collapse(true);
      } else if (last) {
        range.setStartAfter(last);
        range.collapse(true);
      } else {
        range.setStart(root, 0);
        range.collapse(true);
      }
    }
  } else {
    range.setStart(pos.node, pos.offset);
    range.collapse(true);
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Arrow-key navigation across atomic chips.
 * Returns true when the caret was jumped (caller should preventDefault).
 */
export function handleChipArrowNav(
  root: HTMLElement,
  key: "ArrowLeft" | "ArrowRight",
): boolean {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (range.startContainer !== root && !root.contains(range.startContainer)) {
    return false;
  }

  const caret = getCaretOffset(root);
  const chips = getChipTextRanges(root);
  if (chips.length === 0) return false;

  if (key === "ArrowRight") {
    for (const { start, end } of chips) {
      // Before chip or stuck inside its virtual range → land after it.
      if (caret >= start && caret < end) {
        setCaretOffset(root, end);
        return true;
      }
    }
  } else {
    for (let i = chips.length - 1; i >= 0; i--) {
      const chip = chips[i];
      if (!chip) continue;
      const { start, end } = chip;
      // After chip or stuck inside → land before it.
      if (caret > start && caret <= end) {
        setCaretOffset(root, start);
        return true;
      }
    }
  }
  return false;
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
    "inline-flex items-center gap-0.5 px-1 rounded align-baseline select-none cursor-default text-[11px] bg-accent text-accent-foreground font-medium";
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
    "inline-flex items-center gap-0.5 px-1 rounded align-baseline select-none cursor-default text-[11px] bg-primary/15 text-primary font-medium";
  chip.innerHTML = `<span class="opacity-60 text-[10px]">#</span>${escapeHtml(handle)}`;

  deleteRangeInsertNode(root, start, end, chip);
  return start + `[#${handle}]`.length + 1;
}

/**
 * Replace the text range [start..end] with an agent mention chip.
 * Plain-text form: [agent:handle] (distinct from file [@name] chips).
 */
export function insertAgentChip(
  root: HTMLElement,
  start: number,
  end: number,
  handle: string,
): number {
  const chip = document.createElement("span");
  chip.setAttribute("contenteditable", "false");
  chip.dataset.chip = "agent";
  chip.dataset.name = handle;
  chip.className =
    "inline-flex items-center gap-0.5 px-1 rounded align-baseline select-none cursor-default text-[11px] bg-sky-500/15 text-sky-600 dark:text-sky-400 font-medium";
  chip.innerHTML = `<span class="opacity-60 text-[10px]">@</span>${escapeHtml(handle)}`;

  deleteRangeInsertNode(root, start, end, chip);
  return start + `[agent:${handle}]`.length + 1;
}

/**
 * Ensure a text node follows `chip` and starts with whitespace so the caret
 * can sit after the atomic chip (browsers struggle with contenteditable=false
 * when nothing operable follows).
 */
function ensureTrailingTextAfterChip(chip: HTMLElement): Text {
  const next = chip.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE) {
    const space = document.createTextNode(" ");
    chip.parentNode?.insertBefore(space, chip.nextSibling);
    return space;
  }
  const tn = next as Text;
  const t = tn.textContent ?? "";
  if (t.length === 0) {
    tn.textContent = " ";
  } else if (!/^[\s\n]/.test(t)) {
    tn.textContent = ` ${t}`;
  }
  return tn;
}

/** Place the live selection at offset `textOffset` inside a text node. */
function placeCaretInText(node: Text, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  const max = node.textContent?.length ?? 0;
  range.setStart(node, Math.min(Math.max(0, offset), max));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
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

  // Root-level positions use child indices; text/keyword positions use node offsets.
  if (startPos.node === root) {
    range.setStart(root, startPos.offset);
  } else {
    range.setStart(startPos.node, startPos.offset);
  }
  if (endPos.node === root) {
    range.setEnd(root, endPos.offset);
  } else {
    range.setEnd(endPos.node, endPos.offset);
  }
  range.deleteContents();
  range.insertNode(node);

  // Trailing operable text + caret after the mandatory space so highlight
  // restore / typing land past the chip instead of on its leading edge.
  const trailing = ensureTrailingTextAfterChip(node);
  placeCaretInText(trailing, 1);
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

/**
 * Remove or flatten any nodes inside the contenteditable that are not:
 * - text nodes
 * - our controlled chip spans (file/snippet/command/agent)
 * - pipeline keyword highlight spans
 * - ghost autocomplete spans
 * Also normalizes <br> into \n text nodes for consistent plain-text value.
 * Call on edit paths (paste, input) to keep the DOM hierarchy clean.
 */
export function sanitizeContentEditable(root: HTMLElement): void {
  // Work on a snapshot because we mutate during iteration
  const children = Array.from(root.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) continue;

    if (child instanceof HTMLElement) {
      const chipKind = child.dataset.chip;
      if (
        chipKind === "file" ||
        chipKind === "snippet" ||
        chipKind === "agent" ||
        chipKind === "command"
      ) {
        continue;
      }
      if (child.dataset.pipelineKw !== undefined) {
        // Keep only a single text child
        const t = child.textContent ?? "";
        if (
          child.childNodes.length !== 1 ||
          child.firstChild?.nodeType !== Node.TEXT_NODE
        ) {
          child.replaceChildren(document.createTextNode(t));
        }
        continue;
      }
      if (child.dataset.ghost !== undefined) continue;

      if (child.tagName === "BR") {
        child.replaceWith(document.createTextNode("\n"));
        continue;
      }

      // Bad node (img, rich span, div, etc from paste). Flatten to its text or remove.
      const txt = child.textContent ?? "";
      if (txt) {
        child.replaceWith(document.createTextNode(txt));
      } else {
        child.remove();
      }
      continue;
    }

    // Other node types (comments, etc.)
    child.parentNode?.removeChild(child);
  }
}

// ---------------------------------------------------------------------------
// Pipeline DSL keyword highlighting (loop / break / pass / ->)
// ---------------------------------------------------------------------------

/**
 * Keywords that make loops/chains feel live in the composer.
 * `loop` and `loop 15` (iteration count) both match. No bare ":" (normal prose).
 * Free-standing "if" only when followed by a break condition word.
 */
const PIPELINE_KW_RE =
  /\bloop(?:\s+\d+)?\b|\b(?:endloop|break|pass|fail|done|ok|end|then)\b|\bif\b(?=\s+(?:pass|fail|done|ok|always|never)\b)|->/gi;

/** True when the composer text looks like a pipeline (not normal chat). */
export function looksLikePipeline(text: string): boolean {
  return (
    /@[\w-]/.test(text) ||
    /\[agent:/.test(text) ||
    /\bloop\b/i.test(text) ||
    /\bbreak\b/i.test(text) ||
    /->/.test(text)
  );
}

function kwClassName(raw: string): string {
  const k = raw.toLowerCase();
  if (k === "loop" || k === "end" || k === "endloop") {
    return "xterax-pipe-kw xterax-pipe-kw-loop";
  }
  if (k === "break") return "xterax-pipe-kw xterax-pipe-kw-break";
  if (k === "if" || k === "then") {
    return "xterax-pipe-kw xterax-pipe-kw-meta";
  }
  if (k === "pass" || k === "ok" || k === "done") {
    return "xterax-pipe-kw xterax-pipe-kw-pass";
  }
  if (k === "fail") return "xterax-pipe-kw xterax-pipe-kw-fail";
  if (raw === "->") {
    return "xterax-pipe-kw xterax-pipe-kw-op";
  }
  if (/^\d+$/.test(raw)) {
    return "xterax-pipe-kw xterax-pipe-kw-num";
  }
  return "xterax-pipe-kw";
}

function appendKwSpan(
  frag: DocumentFragment,
  raw: string,
  kind: string,
): void {
  const span = document.createElement("span");
  span.dataset.pipelineKw = kind;
  span.className = kwClassName(raw);
  span.textContent = raw;
  frag.appendChild(span);
}

/** Flatten keyword spans back to text so we can re-highlight cleanly. */
export function flattenPipelineKeywords(root: HTMLElement): void {
  const spans = root.querySelectorAll("[data-pipeline-kw]");
  for (const el of Array.from(spans)) {
    const t = el.textContent ?? "";
    el.replaceWith(document.createTextNode(t));
  }
  root.normalize();
}

/**
 * Highlight pipeline DSL keywords in top-level text nodes.
 * Preserves chips; call after sanitize. Does not move the caret — caller should
 * save/restore offset around this.
 */
export function highlightPipelineKeywords(root: HTMLElement): void {
  // Snapshot text nodes (highlighting mutates the tree)
  const textNodes: Text[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      textNodes.push(child as Text);
    }
  }

  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!text) continue;
    PIPELINE_KW_RE.lastIndex = 0;
    if (!PIPELINE_KW_RE.test(text)) continue;
    PIPELINE_KW_RE.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = PIPELINE_KW_RE.exec(text)) !== null) {
      if (m.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      }
      const raw = m[0];
      // `loop 15` → highlight "loop" and the count "15" separately
      const loopN = raw.match(/^loop(\s+)(\d+)$/i);
      if (loopN) {
        appendKwSpan(frag, "loop", "loop");
        frag.appendChild(document.createTextNode(loopN[1]));
        appendKwSpan(frag, loopN[2], "num");
      } else {
        const kind =
          raw.toLowerCase() === "->" ? "arrow" : raw.toLowerCase();
        appendKwSpan(frag, raw, kind);
      }
      last = m.index + raw.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    node.parentNode?.replaceChild(frag, node);
  }
}

/**
 * Full refresh of pipeline keyword highlights while preserving caret.
 * Safe to call on every input. Only paints spans when the text looks like a
 * pipeline so normal prose is not shredded into keyword chips.
 */
export function refreshPipelineKeywordHighlights(root: HTMLElement): void {
  const caret = getCaretOffset(root);
  flattenPipelineKeywords(root);
  sanitizeContentEditable(root);
  const text = editorToText(root);
  if (text.trim().length > 0 && looksLikePipeline(text)) {
    highlightPipelineKeywords(root);
  }
  setCaretOffset(root, caret);
}

/** Insert plain text at the current cursor position (sanitizes first). */
export function insertTextAtCaret(root: HTMLElement, text: string) {
  sanitizeContentEditable(root);
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) {
    root.appendChild(document.createTextNode(text));
    return;
  }
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    root.appendChild(document.createTextNode(text));
    return;
  }
  range.deleteContents();
  const tn = document.createTextNode(text);
  range.insertNode(tn);
  range.setStartAfter(tn);
  range.collapse(true);
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
  if (node instanceof HTMLElement && node.dataset.chip === "agent") {
    // Must match editorToText: [agent:handle]
    return `[agent:${node.dataset.name ?? "agent"}]`.length;
  }
  if (node instanceof HTMLElement && node.dataset.chip === "command") {
    return `[/${node.dataset.name ?? "cmd"}]`.length;
  }
  if (node instanceof HTMLElement && node.dataset.pipelineKw !== undefined) {
    return node.textContent?.length ?? 0;
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
