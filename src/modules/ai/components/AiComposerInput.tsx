import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { usePresence } from "@/lib/usePresence";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { acpAgentHandle } from "../lib/agents";
import { useChatAutocomplete } from "../lib/chatAutocomplete/useChatAutocomplete";
import { useComposer } from "../lib/composer";
import {
  editorToText,
  getCaretOffset,
  handleChipArrowNav,
  insertAgentChip,
  insertFileChip,
  insertSnippetChip,
  insertTextAtCaret,
  refreshPipelineKeywordHighlights,
  sanitizeContentEditable,
  setCaretOffset,
  textOffsetToDom,
} from "../lib/contenteditable";
import { formatLoopPreset } from "../lib/pipelineDsl";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { useAgentsStore } from "../store/agentsStore";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { ChipsRow } from "./ChipsRow";
import { type PickerItem, SnippetPickerContent } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
  char: "#" | "/";
};

type AgentTrigger = {
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

function detectAgentTrigger(value: string, caret: number): AgentTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      // Allow start of input, whitespace, or right after a chip marker `]`.
      const prev = i === 0 ? " " : value[i - 1];
      if (i > 0 && !/\s/.test(prev) && prev !== "]") return null;
      const slice = value.slice(i + 1, caret);
      // Only the handle token — stop if the user typed past a valid mention.
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase() };
    }
    if (/\s/.test(ch)) return null;
    // Do not walk through chip markers ([agent:…], [@file], etc.)
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

// Module-level selectors so Zustand v5's useCallback(() => selector(getState()),
// [api, selector]) sees a stable `selector` reference across renders. Inline
// arrows would recreate getSnapshot every render, and together with
// useSyncExternalStore's consistency check this triggers infinite loops when
// the selected value is a non-primitive (array/object).
const selectSnippets = (s: ReturnType<typeof useSnippetsStore.getState>) =>
  s.snippets;
const selectSkillsConfigs = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.skillsConfigs;
const selectPipelineLoops = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.pipelineLoops;
const selectAgentsAll = (s: ReturnType<typeof useAgentsStore.getState>) =>
  s.all();
const selectAcpAgents = (s: ReturnType<typeof usePreferencesStore.getState>) =>
  s.acpAgents ?? [];

export function AiComposerInput() {
  const c = useComposer();
  const snippets = useSnippetsStore(selectSnippets);
  const skillsConfigs = usePreferencesStore(selectSkillsConfigs);
  const pipelineLoops = usePreferencesStore(selectPipelineLoops);
  const agents = useAgentsStore(selectAgentsAll);
  const acpAgents = usePreferencesStore(selectAcpAgents).filter(
    (a) => a.enabled,
  );
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Keep composer's textareaRef pointed at our editor for focus / submit.
  useLayoutEffect(() => {
    (c.textareaRef as React.MutableRefObject<HTMLDivElement | null>).current =
      editorRef.current;
  }, [editorRef]);

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [agentTrigger, setAgentTrigger] = useState<AgentTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const workspaceFiles = useWorkspaceFiles(
    workspaceRoot,
    agentTrigger !== null,
  );

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!agentTrigger) {
      setFileQuery("");
      return;
    }
    const q = agentTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [agentTrigger]);

  // Sync editor DOM when value changes externally (e.g. submit clears it).
  const syncing = useRef(false);
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    if (c.value === "") {
      // Always clear DOM when state is empty so the placeholder shows cleanly.
      // Strip chips, keyword spans, ghosts, and browser-inserted <br>s.
      // Residual nodes under data-empty cause the placeholder to paint on top
      // of leftover text (looks like random overlapping flow).
      el.replaceChildren();
      el.removeAttribute("data-pipeline");
      // Restore cursor so the blinking caret stays visible.
      if (document.activeElement === el) {
        requestAnimationFrame(() => {
          if (!editorRef.current) return;
          // Browser may have re-inserted a <br> while focused; clear again.
          if (editorRef.current.childNodes.length > 0) {
            editorRef.current.replaceChildren();
          }
          editorRef.current.focus();
          const sel = window.getSelection();
          if (sel) {
            const r = document.createRange();
            r.setStart(editorRef.current, 0);
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
        el.replaceChildren(document.createTextNode(c.value));
        refreshPipelineKeywordHighlights(el);
      }
    }
    syncing.current = false;
    if (c.value !== "") {
      sanitizeContentEditable(el);
    }

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
      setAgentTrigger(null);
      return;
    }
    sanitizeContentEditable(el);
    const caret = getCaretOffset(el);
    const text = editorToText(el);
    // Keep c.value in sync (submit reads from it).
    c.setValue(text);
    setTrigger(detectSnippetTrigger(text, caret));
    setAgentTrigger(detectAgentTrigger(text, caret));
  };

  // updateTrigger is called directly from onInput — no effect needed.

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;

    if (trigger.char === "#") {
      // # shows snippets + saved loop presets
      const snipItems: PickerItem[] = snippets
        .filter(
          (s) =>
            !q ||
            s.handle.includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q),
        )
        .map((snippet) => ({ kind: "snippet" as const, snippet }));
      const loopItems: PickerItem[] = (pipelineLoops.presets ?? [])
        .filter(
          (p) =>
            !q ||
            p.handle.includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q),
        )
        .map((preset) => ({ kind: "loop" as const, preset }));
      return [...loopItems, ...snipItems];
    }

    // / shows commands + enabled skills
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));

    const enabledSkills = skillsConfigs.filter((s) => s.enabled);
    const skillItems: PickerItem[] = enabledSkills
      .filter(
        (s) =>
          !q || s.name.includes(q) || s.description.toLowerCase().includes(q),
      )
      .map((skill) => ({ kind: "skill", skill }));

    return [...cmdItems, ...skillItems];
  }, [trigger, snippets, skillsConfigs, pipelineLoops.presets]);

  // Agent + file items for @ trigger
  const FILE_PICKER_CAP = 20;
  const filteredFiles = useMemo<string[]>(() => {
    if (!agentTrigger) return [];
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
  }, [agentTrigger, fileQuery, workspaceFiles.files]);

  const filteredAgentsAndFiles = useMemo<PickerItem[]>(() => {
    if (!agentTrigger) return [];
    const q = agentTrigger.query;
    // Local agents, then ACP, then files — order matches keyboard activeIndex
    const agentItems: PickerItem[] = agents
      .filter(
        (a) =>
          !q ||
          a.handle.includes(q) ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      )
      .map((agent) => ({ kind: "agent" as const, agent }));

    const reserved = new Set(agents.map((a) => a.handle));
    const acpItems: PickerItem[] = [];
    for (const config of acpAgents) {
      const handle = acpAgentHandle(config, reserved);
      reserved.add(handle);
      if (
        !q ||
        handle.includes(q) ||
        config.name.toLowerCase().includes(q) ||
        config.command.toLowerCase().includes(q)
      ) {
        acpItems.push({ kind: "acp", config, handle });
      }
    }

    const fileItems: PickerItem[] = filteredFiles.map((f) => ({
      kind: "file" as const,
      filePath: f,
    }));
    return [...agentItems, ...acpItems, ...fileItems];
  }, [agentTrigger, agents, acpAgents, filteredFiles]);

  const agentTriggerOpen = agentTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, agentTriggerOpen, fileQuery]);

  const pickerOpen = trigger !== null || agentTrigger !== null;

  // Determine which items to show
  const activeItems = agentTrigger ? filteredAgentsAndFiles : filteredItems;

  const onPickItem = (item: PickerItem) => {
    const el = editorRef.current;
    if (!el) return;

    if (item.kind === "agent" || item.kind === "acp") {
      // Insert an agent mention chip (pipeline invocation, not mode switch)
      if (!agentTrigger) return;
      const handle = item.kind === "agent" ? item.agent.handle : item.handle;
      const cursorAfter = insertAgentChip(
        el,
        agentTrigger.start,
        agentTrigger.end,
        handle,
      );
      refreshPipelineKeywordHighlights(el);
      syncing.current = true;
      c.setValue(editorToText(el));
      setAgentTrigger(null);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        if (!editorRef.current) return;
        editorRef.current.focus();
        setCaretOffset(editorRef.current, cursorAfter);
      });
      return;
    }

    if (item.kind === "file") {
      // Attach file via @ picker
      if (!agentTrigger || !workspaceRoot) return;
      const fileName = item.filePath.split("/").pop() || item.filePath;
      const cursorAfter = insertFileChip(
        el,
        agentTrigger.start,
        agentTrigger.end,
        fileName,
      );
      syncing.current = true;
      c.setValue(editorToText(el));
      setAgentTrigger(null);
      setActiveIndex(0);

      const fullPath = workspaceRoot.endsWith("/")
        ? `${workspaceRoot}${item.filePath}`
        : `${workspaceRoot}/${item.filePath}`;
      void c.attachFileByPath(fullPath);

      requestAnimationFrame(() => {
        if (!editorRef.current) return;
        editorRef.current.focus();
        setCaretOffset(editorRef.current, cursorAfter);
      });
      return;
    }

    if (!trigger) return;

    let cursorAfter = trigger.end;
    if (item.kind === "loop") {
      // Expand saved loop preset into full DSL text (not a chip).
      const dsl = formatLoopPreset(
        item.preset,
        pipelineLoops.absoluteMax,
      );
      el.focus();
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        const startPos = textOffsetToDom(el, trigger.start);
        const endPos = textOffsetToDom(el, trigger.end);
        if (startPos && endPos) {
          r.setStart(startPos.node, startPos.offset);
          r.setEnd(endPos.node, endPos.offset);
          r.deleteContents();
          r.insertNode(document.createTextNode(dsl + "\n"));
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      cursorAfter = trigger.start + dsl.length + 1;
      refreshPipelineKeywordHighlights(el);
      syncing.current = true;
      c.setValue(editorToText(el));
      setTrigger(null);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        if (!editorRef.current) return;
        editorRef.current.focus();
        setCaretOffset(editorRef.current, cursorAfter);
      });
      return;
    }
    if (item.kind === "snippet") {
      c.addSnippet(item.snippet);
      cursorAfter = insertSnippetChip(
        el,
        trigger.start,
        trigger.end,
        item.snippet.handle,
      );
    } else if (item.kind === "skill") {
      // Insert /skill-name as inline text
      const skillText = `/${item.skill.name}`;
      el.focus();
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0);
        const startPos = textOffsetToDom(el, trigger.start);
        const endPos = textOffsetToDom(el, trigger.end);
        if (startPos && endPos) {
          r.setStart(startPos.node, startPos.offset);
          r.setEnd(endPos.node, endPos.offset);
          r.deleteContents();
          r.insertNode(document.createTextNode(skillText + " "));
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      }
      cursorAfter = trigger.start + skillText.length + 1;
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

  const pickActive = () => {
    const it = activeItems[activeIndex];
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
    handleKeyDown: handleAutocompleteKey,
    trigger: triggerAutocomplete,
    cancelPending: cancelAutocomplete,
  } = useChatAutocomplete(editorRef, pickerOpen, handleAutocompleteAccept);

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const el = editorRef.current;
    if (!el) return;
    const cd = e.clipboardData;
    if (!cd) return;

    // Route file/image pastes to attachments (ChipsRow) — never insert rich/img into the editor DOM.
    // This prevents hierarchy pollution and translucency artifacts inside the contenteditable.
    if (cd.files && cd.files.length > 0) {
      e.preventDefault();
      void c.addFiles(cd.files);
      requestAnimationFrame(() => {
        if (editorRef.current) editorRef.current.focus();
      });
      return;
    }

    // Always paste as plain text only. Strip any HTML/RTF/other formats.
    const plain = cd.getData("text/plain");
    if (plain != null) {
      e.preventDefault();
      insertTextAtCaret(el, plain);
      refreshPipelineKeywordHighlights(el);
      syncing.current = true;
      const text = editorToText(el);
      c.setValue(text);
      triggerAutocomplete(text, el);
      updateTrigger();
    }
    // If neither files nor plain text, do nothing (no rich content allowed).
  };

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
                next.textContent =
                  (prev.textContent ?? "") + (next.textContent ?? "");
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
              next.textContent =
                (prev.textContent ?? "") + (next.textContent ?? "");
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
          <div className="relative min-w-0 flex-1">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline
              aria-label="Message Xterax"
              data-empty={c.value === "" ? "true" : undefined}
              onPaste={handlePaste}
              onInput={() => {
                const el = editorRef.current;
                if (!el) return;
                // When the user deletes everything, drop residual markup so the
                // placeholder does not stack on leftover keyword/ghost nodes.
                const raw = editorToText(el);
                if (raw.trim() === "") {
                  el.replaceChildren();
                  syncing.current = true;
                  c.setValue("");
                  cancelAutocomplete();
                  setTrigger(null);
                  setAgentTrigger(null);
                  return;
                }
                // Highlight loop/break/pass/-> only for pipeline-like text
                refreshPipelineKeywordHighlights(el);
                syncing.current = true;
                const text = editorToText(el);
                c.setValue(text);
                triggerAutocomplete(text, el);
                updateTrigger();
              }}
              onClick={updateTrigger}
              onKeyUp={updateTrigger}
              onKeyDown={(e) => {
                // Autocomplete ghost text takes priority (Tab or Right arrow to accept, Esc to dismiss).
                if (handleAutocompleteKey(e)) return;
                if (pickerOpen) {
                  const items = activeItems;
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
                    if (agentTrigger) {
                      const el = editorRef.current;
                      if (el) {
                        const r = document.createRange();
                        const s = textOffsetToDom(el, agentTrigger.start);
                        const en = textOffsetToDom(el, agentTrigger.end);
                        if (s && en) {
                          if (s.node === el) r.setStart(el, s.offset);
                          else r.setStart(s.node, s.offset);
                          if (en.node === el) r.setEnd(el, en.offset);
                          else r.setEnd(en.node, en.offset);
                          r.deleteContents();
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
                      c.setValue(
                        editorToText(el ?? document.createElement("div")),
                      );
                      setAgentTrigger(null);
                    } else {
                      setTrigger(null);
                    }
                    return;
                  }
                }
                // Jump over contenteditable=false chips — native arrow nav gets
                // stuck before/inside them and our caret map used to fling to end.
                if (
                  (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.altKey
                ) {
                  const el = editorRef.current;
                  if (
                    el &&
                    handleChipArrowNav(
                      el,
                      e.key as "ArrowLeft" | "ArrowRight",
                    )
                  ) {
                    e.preventDefault();
                    updateTrigger();
                    return;
                  }
                }
                if (e.key === "Enter") {
                  if (e.shiftKey) {
                    // Shift+Enter inserts a newline at the cursor
                    e.preventDefault();
                    cancelAutocomplete();
                    const el = editorRef.current;
                    if (!el) return;
                    const sel = window.getSelection();
                    if (!sel || !sel.rangeCount) return;
                    const range = sel.getRangeAt(0);
                    if (!el.contains(range.startContainer)) return;
                    range.deleteContents();
                    const nl = document.createTextNode("\n");
                    range.insertNode(nl);
                    range.setStartAfter(nl);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    // Sync the plain-text value
                    syncing.current = true;
                    c.setValue(editorToText(el));
                    return;
                  }
                  e.preventDefault();
                  cancelAutocomplete();
                  c.submit();
                }
              }}
              className={cn(
                "ai-composer-editor min-h-[3.75rem] max-h-40 w-full bg-transparent",
                "text-[13px] leading-5 text-foreground outline-none",
                "whitespace-pre-wrap break-words overflow-y-auto",
              )}
            />
          </div>
        </PopoverAnchor>
        <SnippetPickerContent
          items={activeItems}
          activeIndex={activeIndex}
          onPick={onPickItem}
          onHover={setActiveIndex}
        />
      </Popover>

      {voiceRow.mounted && (
        <div data-state={voiceRow.state} className="xterax-reveal">
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

const AUTORESIZE_MIN = 60;
const AUTORESIZE_MAX = 160;

function autoresize(el: HTMLElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(AUTORESIZE_MIN, Math.min(el.scrollHeight, AUTORESIZE_MAX))}px`;
}
