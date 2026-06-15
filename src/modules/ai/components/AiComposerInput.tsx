import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { usePresence } from "@/lib/usePresence";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { useComposer } from "../lib/composer";
import { useChatAutocomplete } from "../lib/chatAutocomplete/useChatAutocomplete";
import {
  editorToText,
  getCaretOffset,
  setCaretOffset,
  textOffsetToDom,
  insertFileChip,
  insertSnippetChip,
} from "../lib/contenteditable";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { ChipsRow } from "./ChipsRow";
import { FilePickerContent } from "./FilePicker";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";
import { Button } from "@/components/ui/button";
import {
  ArrowRight01Icon,
  Mic01Icon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
  char: "#" | "/";
};

type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#" || ch === "/") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase(), char: ch };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

function detectFileTrigger(value: string, caret: number): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AiComposerInput() {
  const c = useComposer();
  const snippets = useSnippetsStore((s) => s.snippets);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Keep composer's textareaRef pointed at our editor for focus / submit.
  useLayoutEffect(() => {
    (c.textareaRef as React.MutableRefObject<HTMLDivElement | null>).current = editorRef.current;
  }, [editorRef]);

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const workspaceFiles = useWorkspaceFiles(workspaceRoot, fileTrigger !== null);

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!fileTrigger) {
      setFileQuery("");
      return;
    }
    const q = fileTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [fileTrigger]);

  // Sync editor DOM when value changes externally (e.g. submit clears it).
  const syncing = useRef(false);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    if (c.value === "") {
      // Always clear DOM when state is empty so the placeholder shows.
      // Browsers re-insert <br> nodes into focused contenteditables, so we
      // strip them unconditionally — even when the change came from onInput.
      while (el.firstChild) el.removeChild(el.firstChild);
      // Restore cursor so the blinking caret stays visible.
      if (document.activeElement === el) {
        requestAnimationFrame(() => {
          el.focus();
          const sel = window.getSelection();
          if (sel) {
            const r = document.createRange();
            r.setStart(el, 0);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
          }
        });
      }
    } else if (!syncing.current) {
      // Non-empty external change — sync DOM ← state.
      const domText = editorToText(el);
      if (domText !== c.value) {
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(document.createTextNode(c.value));
      }
    }
    syncing.current = false;

    autoresize(el);
  }, [c.value]);

  // Re-run autoresize when the editor width changes (panel open/collapse,
  // window resize) so placeholder-wrapping-based scrollHeight is recalculated.
  const prevWidthRef = useRef(0);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== prevWidthRef.current) {
        prevWidthRef.current = w;
        autoresize(el);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const updateTrigger = () => {
    const el = editorRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = getCaretOffset(el);
    const text = editorToText(el);
    // Keep c.value in sync (submit reads from it).
    c.setValue(text);
    setTrigger(detectSnippetTrigger(text, caret));
    setFileTrigger(detectFileTrigger(text, caret));
  };

  // updateTrigger is called directly from onInput — no effect needed.

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    if (trigger.char === "/") return cmdItems;
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets]);

  const FILE_PICKER_CAP = 30;
  const filteredFiles = useMemo<string[]>(() => {
    if (!fileTrigger) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return workspaceFiles.files.slice(0, FILE_PICKER_CAP);
    const out: string[] = [];
    for (const f of workspaceFiles.files) {
      if (f.toLowerCase().includes(q)) {
        out.push(f);
        if (out.length >= FILE_PICKER_CAP) break;
      }
    }
    return out;
  }, [fileTrigger, fileQuery, workspaceFiles.files]);

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, fileTriggerOpen, fileQuery]);

  const pickerOpen = trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const el = editorRef.current;
    if (!el) return;

    let cursorAfter = trigger.end;
    if (item.kind === "snippet") {
      c.addSnippet(item.snippet);
      cursorAfter = insertSnippetChip(el, trigger.start, trigger.end, item.snippet.handle);
    } else {
      c.addCommand(item.command);
      // For commands, insert [/name] inline text (chip-able later).
      const cmdText = `[/${item.command.name}]`;
      el.focus();
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        // Position the range at trigger.start..trigger.end
        const startPos = textOffsetToDom(el, trigger.start);
        const endPos = textOffsetToDom(el, trigger.end);
        if (startPos && endPos) {
          r.setStart(startPos.node, startPos.offset);
          r.setEnd(endPos.node, endPos.offset);
          r.deleteContents();
          r.insertNode(document.createTextNode(cmdText + " "));
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      cursorAfter = trigger.start + cmdText.length + 1;
    }

    syncing.current = true;
    c.setValue(editorToText(el));
    setTrigger(null);
    setActiveIndex(0);

    requestAnimationFrame(() => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      setCaretOffset(editorRef.current, cursorAfter);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger || !workspaceRoot) return;
    const el = editorRef.current;
    if (!el) return;

    const fileName = filePath.split("/").pop() || filePath;
    // Replace @query text with an inline file chip in the DOM.
    const cursorAfter = insertFileChip(el, fileTrigger.start, fileTrigger.end, fileName);
    // Update React state from the DOM.
    syncing.current = true;
    c.setValue(editorToText(el));

    setFileTrigger(null);
    setActiveIndex(0);

    const fullPath = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${filePath}`
      : `${workspaceRoot}/${filePath}`;
    await c.attachFileByPath(fullPath);

    requestAnimationFrame(() => {
      if (!editorRef.current) return;
      editorRef.current.focus();
      setCaretOffset(editorRef.current, cursorAfter);
    });
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) void onPickFile(file);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;
  const voiceRow = usePresence(Boolean(voiceLabel), 180);
  const lastVoiceLabel = useRef("");
  if (voiceLabel) lastVoiceLabel.current = voiceLabel;

  const handleAutocompleteAccept = useCallback(
    (newValue: string) => {
      syncing.current = true;
      c.setValue(newValue);
    },
    [c],
  );

  const {
    ghostText,
    ghostPos,
    handleKeyDown: handleAutocompleteKey,
    trigger: triggerAutocomplete,
    cancelPending: cancelAutocomplete,
  } = useChatAutocomplete(editorRef, pickerOpen, handleAutocompleteAccept);

  return (
    <>
      <ChipsRow
        files={c.files}
        onRemoveFile={(id) => {
          // Extract file name from the path-id (id = "path-/abs/path").
          const path = id.startsWith("path-") ? id.slice(5) : "";
          const fileName = path.split("/").pop() || "";
          if (fileName && editorRef.current) {
            const chip = editorRef.current.querySelector(
              `[data-chip="file"][data-name="${CSS.escape(fileName)}"]`,
            );
            if (chip) {
              const prev = chip.previousSibling;
              const next = chip.nextSibling;
              chip.remove();
              if (
                prev?.nodeType === Node.TEXT_NODE &&
                next?.nodeType === Node.TEXT_NODE
              ) {
                next.textContent = (prev.textContent ?? "") + (next.textContent ?? "");
                prev.remove();
              }
            }
          }
          c.removeFile(id);
          if (editorRef.current) {
            syncing.current = true;
            c.setValue(editorToText(editorRef.current));
          }
        }}
        snippets={c.pickedSnippets}
        onRemoveSnippet={(id) => {
          const snip = c.pickedSnippets.find((s) => s.id === id);
          c.removeSnippet(id);
          if (!snip || !editorRef.current) return;
          // Remove inline chip from the DOM.
          const chip = editorRef.current.querySelector(
            `[data-chip="snippet"][data-name="${CSS.escape(snip.handle)}"]`,
          );
          if (chip) {
            const prev = chip.previousSibling;
            const next = chip.nextSibling;
            chip.remove();
            // Merge adjacent text nodes that might have surrounded the chip.
            if (
              prev?.nodeType === Node.TEXT_NODE &&
              next?.nodeType === Node.TEXT_NODE
            ) {
              next.textContent = (prev.textContent ?? "") + (next.textContent ?? "");
              prev.remove();
            }
          }
          syncing.current = true;
          c.setValue(editorToText(editorRef.current));
        }}
        commands={c.pickedCommands}
        onRemoveCommand={(name) => c.removeCommand(name)}
      />

      <Popover open={pickerOpen}>
        <PopoverAnchor asChild>
          <div className="relative flex flex-1">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={() => {
                const el = editorRef.current;
                if (!el) return;
                syncing.current = true;
                const text = editorToText(el);
                c.setValue(text);
                triggerAutocomplete(text);
                updateTrigger();
              }}
              onClick={updateTrigger}
              onKeyUp={updateTrigger}
              onKeyDown={(e) => {
                // Autocomplete ghost text takes priority (Tab accept, Esc dismiss).
                if (handleAutocompleteKey(e)) return;
                if (pickerOpen) {
                  const items = fileTrigger ? filteredFiles : filteredItems;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIndex((i) =>
                      Math.min(i + 1, Math.max(0, items.length - 1)),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === "Tab" || e.key === "Enter") {
                    if (items.length > 0) {
                      e.preventDefault();
                      pickActive();
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    if (fileTrigger) {
                      const el = editorRef.current;
                      if (el) {
                        const r = document.createRange();
                        const s = textOffsetToDom(el, fileTrigger.start);
                        const en = textOffsetToDom(el, fileTrigger.end);
                        if (s && en) {
                          r.setStart(s.node, s.offset);
                          r.setEnd(en.node, en.offset);
                          r.deleteContents();
                          // Insert a space if both sides are adjacent to non-space
                          r.insertNode(document.createTextNode(" "));
                          r.collapse(false);
                          const sel = window.getSelection();
                          if (sel) {
                            sel.removeAllRanges();
                            sel.addRange(r);
                          }
                        }
                      }
                      syncing.current = true;
                      c.setValue(editorToText(el ?? document.createElement("div")));
                      setFileTrigger(null);
                    } else {
                      setTrigger(null);
                    }
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  cancelAutocomplete();
                  c.submit();
                }
              }}
              className={cn(
                "min-h-[5rem] max-h-40 w-full bg-transparent text-[13px] leading-relaxed outline-none",
                "whitespace-pre-wrap break-words overflow-y-auto pr-8",
              )}
            />
            {/* State-driven placeholder — avoids browser :empty / <br> quirks */}
            {c.value === "" && !pickerOpen && (
              <span
                className="pointer-events-none absolute left-0 top-0 text-[13px] leading-relaxed text-muted-foreground/60 select-none"
                aria-hidden
              >
                Ask Terax anything{"  "}—{"  "}# for snippets and commands, @ for files
              </span>
            )}

            {/* Ghost text autocomplete overlay */}
            {ghostText && ghostPos && (
              <span
                aria-hidden
                className="pointer-events-none absolute text-[13px] leading-relaxed italic text-muted-foreground/45 select-none whitespace-pre-wrap break-words"
                style={{ left: ghostPos.x, top: ghostPos.y }}
              >
                {ghostText}
              </span>
            )}

            {/* Top-right: send / stop */}
            {c.isBusy ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={c.stop}
                className="absolute right-1 top-1 size-6"
                aria-label="Stop"
                title="Stop"
              >
                <HugeiconsIcon icon={StopCircleIcon} size={13} strokeWidth={1.75} />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={c.submit}
                disabled={!c.canSend}
                className="absolute right-1 top-1 h-5.5 w-7.5 rounded-md"
                aria-label="Send"
                title="Send (Enter)"
              >
                <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.75} />
              </Button>
            )}

            {/* Bottom-right: mic */}
            {c.voice.supported && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title={
                  !c.voice.hasKey
                    ? "Voice needs an OpenAI key"
                    : c.voice.recording
                      ? "Stop & transcribe"
                      : c.voice.transcribing
                        ? "Transcribing…"
                        : "Voice input"
                }
                onClick={() =>
                  c.voice.recording ? c.voice.stop() : void c.voice.start()
                }
                disabled={c.isBusy || c.voice.transcribing || !c.voice.hasKey}
                className={cn(
                  "absolute right-1 bottom-1 size-6 rounded-md text-muted-foreground hover:text-foreground",
                  c.voice.recording &&
                    "bg-destructive/10 text-destructive hover:bg-destructive/15",
                )}
              >
                {c.voice.recording ? (
                  <span className="size-2 animate-pulse rounded-full bg-destructive" />
                ) : c.voice.transcribing ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon icon={Mic01Icon} size={13} strokeWidth={1.75} />
                )}
              </Button>
            )}
          </div>
        </PopoverAnchor>
        {fileTrigger ? (
          <FilePickerContent
            files={filteredFiles}
            activeIndex={activeIndex}
            indexing={workspaceFiles.indexing}
            truncated={workspaceFiles.truncated}
            hasWorkspace={workspaceRoot !== null}
            onPick={(f) => void onPickFile(f)}
            onHover={setActiveIndex}
          />
        ) : (
          <SnippetPickerContent
            items={filteredItems}
            activeIndex={activeIndex}
            onPick={onPickItem}
            onHover={setActiveIndex}
          />
        )}
      </Popover>

      {voiceRow.mounted && (
        <div data-state={voiceRow.state} className="terax-reveal">
          <div className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
            {c.voice.recording ? (
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-3" />
            )}
            <span className="truncate">
              {voiceLabel || lastVoiceLabel.current}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

const AUTORESIZE_MIN = 80;
const AUTORESIZE_MAX = 160;

function autoresize(el: HTMLElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(AUTORESIZE_MIN, Math.min(el.scrollHeight, AUTORESIZE_MAX))}px`;
}
