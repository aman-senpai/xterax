import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CsvViewToggle } from "./CsvViewToggle";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type CellRef = { row: number; col: number };

type SelectionRange = {
  anchor: CellRef;
  active: CellRef;
};

type EditingCell = {
  row: number; // -1 = header row
  col: number;
  value: string;
};

type Props = {
  path: string;
  visible: boolean;
  onSetView: (mode: "spreadsheet" | "raw") => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 28; // px — fixed row height for virtual scrolling
const HEADER_HEIGHT = 32; // px — sticky header height
const OVERSCAN = 6; // extra rows above and below viewport

// ---------------------------------------------------------------------------
// 10-hue rainbow palette (matches languageResolver.ts)
// ---------------------------------------------------------------------------

const COL_COLORS_LIGHT = [
  "oklch(0.48 0.18 25)",
  "oklch(0.50 0.16 55)",
  "oklch(0.48 0.17 145)",
  "oklch(0.50 0.18 240)",
  "oklch(0.46 0.20 305)",
  "oklch(0.50 0.17 185)",
  "oklch(0.52 0.18 340)",
  "oklch(0.50 0.15 95)",
  "oklch(0.50 0.17 195)",
  "oklch(0.46 0.16 270)",
];

const COL_COLORS_DARK = [
  "oklch(0.80 0.17 25)",
  "oklch(0.82 0.15 55)",
  "oklch(0.80 0.17 145)",
  "oklch(0.82 0.16 240)",
  "oklch(0.80 0.18 305)",
  "oklch(0.82 0.15 185)",
  "oklch(0.80 0.17 340)",
  "oklch(0.82 0.14 95)",
  "oklch(0.80 0.16 195)",
  "oklch(0.80 0.15 270)",
];

// ---------------------------------------------------------------------------
// Pure helpers (defined outside component — never re-created)
// ---------------------------------------------------------------------------

function detectDelimiter(content: string): string {
  const firstLine = content.split("\n")[0] ?? "";
  return (firstLine.match(/\t/g) ?? []).length >
    (firstLine.match(/,/g) ?? []).length
    ? "\t"
    : ",";
}

function parseCsv(content: string, sep: string): string[][] {
  const rows: string[][] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line === "") continue;
    const cells: string[] = [];
    let i = 0;
    let cell = "";
    while (i <= line.length) {
      if (i === line.length) {
        cells.push(cell);
        break;
      }
      if (line[i] === '"' && sep !== "\t") {
        i++;
        while (i < line.length) {
          if (line[i] === '"') {
            i++;
            if (i < line.length && line[i] === '"') {
              cell += '"';
              i++;
            } else {
              break;
            }
          } else {
            cell += line[i++];
          }
        }
      } else if (line[i] === sep) {
        cells.push(cell);
        cell = "";
        i++;
      } else {
        cell += line[i++];
      }
    }
    rows.push(cells);
  }
  return rows;
}

/** Serialize rows back to CSV text. */
function serializeCsv(rows: string[][], sep: string): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (sep === "\t") return cell;
          // Quote if contains sep, quote, or newline
          if (cell.includes(sep) || cell.includes('"') || cell.includes("\n")) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(sep),
    )
    .join("\n");
}

/** Normalize a selection range so min-row/col is always first. */
function normalizeRange(sel: SelectionRange): {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
} {
  return {
    minRow: Math.min(sel.anchor.row, sel.active.row),
    maxRow: Math.max(sel.anchor.row, sel.active.row),
    minCol: Math.min(sel.anchor.col, sel.active.col),
    maxCol: Math.max(sel.anchor.col, sel.active.col),
  };
}

function cellInRange(
  row: number,
  col: number,
  sel: SelectionRange | null,
): boolean {
  if (!sel) return false;
  const { minRow, maxRow, minCol, maxCol } = normalizeRange(sel);
  return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CsvPreviewPane({ path, visible, onSetView }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  // Mutable grid: starts as parsed snapshot, edits mutate this ref
  const gridRef = useRef<string[][]>([]);
  // We track a version counter to force re-renders after edits
  const [gridVersion, setGridVersion] = useState(0);

  const sepRef = useRef(",");

  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  // Dark-mode observer
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains("dark"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // Load file
  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    })
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          const sep = detectDelimiter(res.content);
          sepRef.current = sep;
          gridRef.current = parseCsv(res.content, sep);
          setStatus({ kind: "ready", content: res.content });
          setGridVersion((v) => v + 1);
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({ kind: "toolarge", size: res.size, limit: res.limit });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Save grid back to disk
  const saveGrid = useCallback(async () => {
    const content = serializeCsv(gridRef.current, sepRef.current);
    await invoke("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
      source: "csv-editor",
    });
  }, [path]);

  // ---------------------------------------------------------------------------
  // Derived grid data (stable across re-renders unless gridVersion changes)
  // ---------------------------------------------------------------------------

  const { header, dataRows, colCount } = useMemo(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    void gridVersion; // subscribe to grid changes
    const rows = gridRef.current;
    const hasHeader = rows.length > 1;
    const header = hasHeader ? rows[0] : null;
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const colCount = rows.length > 0 ? Math.max(...rows.map((r) => r.length), 0) : 0;
    return { header, dataRows, colCount };
  }, [gridVersion]);

  // ---------------------------------------------------------------------------
  // Selection state
  // ---------------------------------------------------------------------------

  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Focus input when editing starts
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        editInputRef.current?.focus();
        editInputRef.current?.select();
      });
    }
  }, [editing]);

  const commitEdit = useCallback(
    (row: number, col: number, value: string) => {
      // row: -1 = header, 0+ = data rows
      const gridRow = row === -1 ? 0 : row + 1;
      if (!gridRef.current[gridRow]) return;
      // Extend row if needed
      while (gridRef.current[gridRow].length <= col) {
        gridRef.current[gridRow].push("");
      }
      gridRef.current[gridRow][col] = value;
      setEditing(null);
      setGridVersion((v) => v + 1);
      void saveGrid();
    },
    [saveGrid],
  );

  const cancelEdit = useCallback(() => setEditing(null), []);

  // ---------------------------------------------------------------------------
  // Copy
  // ---------------------------------------------------------------------------

  const copySelection = useCallback(() => {
    if (!selection) return;
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(selection);
    const lines: string[] = [];
    for (let r = minRow; r <= maxRow; r++) {
      const row = dataRows[r] ?? [];
      const cells = Array.from({ length: maxCol - minCol + 1 }, (_, ci) => {
        return row[minCol + ci] ?? "";
      });
      lines.push(cells.join("\t"));
    }
    void navigator.clipboard.writeText(lines.join("\n"));
  }, [selection, dataRows]);

  // Ctrl+C / Ctrl+A
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (editing) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        copySelection();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        if (dataRows.length === 0 || colCount === 0) return;
        setSelection({
          anchor: { row: 0, col: 0 },
          active: { row: dataRows.length - 1, col: colCount - 1 },
        });
      }
      // Arrow key navigation
      if (selection && !e.ctrlKey && !e.metaKey) {
        const { active } = selection;
        let { row, col } = active;
        if (e.key === "ArrowRight") { col = Math.min(col + 1, colCount - 1); e.preventDefault(); }
        else if (e.key === "ArrowLeft") { col = Math.max(col - 1, 0); e.preventDefault(); }
        else if (e.key === "ArrowDown") { row = Math.min(row + 1, dataRows.length - 1); e.preventDefault(); }
        else if (e.key === "ArrowUp") { row = Math.max(row - 1, 0); e.preventDefault(); }
        else return;
        const next: CellRef = { row, col };
        if (e.shiftKey) {
          setSelection((prev) => prev ? { anchor: prev.anchor, active: next } : { anchor: next, active: next });
        } else {
          setSelection({ anchor: next, active: next });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, selection, editing, copySelection, dataRows.length, colCount]);

  // ---------------------------------------------------------------------------
  // Cell click handlers
  // ---------------------------------------------------------------------------

  const handleCellClick = useCallback(
    (e: React.MouseEvent, row: number, col: number) => {
      e.preventDefault();
      if (editing) setEditing(null);
      if (e.shiftKey && selection) {
        setSelection({ anchor: selection.anchor, active: { row, col } });
      } else {
        setSelection({ anchor: { row, col }, active: { row, col } });
      }
    },
    [editing, selection],
  );

  const handleCellDoubleClick = useCallback(
    (e: React.MouseEvent, isHeader: boolean, row: number, col: number) => {
      e.preventDefault();
      const gridRow = isHeader ? 0 : row + 1;
      const value = gridRef.current[gridRow]?.[col] ?? "";
      setEditing({ row: isHeader ? -1 : row, col, value });
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Virtual scrolling
  // ---------------------------------------------------------------------------

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setContainerHeight(entries[0]?.contentRect.height ?? 400);
    });
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    setScrollTop(scrollContainerRef.current?.scrollTop ?? 0);
  }, []);

  const totalDataRows = dataRows.length;


  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil((containerHeight - HEADER_HEIGHT) / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(totalDataRows, startIdx + visibleCount);

  const visibleRows = dataRows.slice(startIdx, endIdx);
  const paddingTop = startIdx * ROW_HEIGHT;
  const paddingBottom = Math.max(0, (totalDataRows - endIdx) * ROW_HEIGHT);

  // ---------------------------------------------------------------------------
  // Colors
  // ---------------------------------------------------------------------------

  const palette = isDark ? COL_COLORS_DARK : COL_COLORS_LIGHT;
  const colColor = (ci: number) => palette[ci % palette.length];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!visible) return null;

  const statsLabel =
    status.kind === "ready" && colCount > 0
      ? `${totalDataRows.toLocaleString()} row${totalDataRows !== 1 ? "s" : ""} · ${colCount} col${colCount !== 1 ? "s" : ""}`
      : undefined;

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background">
      {/* Toggle — always absolute top-right, matching raw-editor mode */}
      <CsvViewToggle mode="spreadsheet" onChange={onSetView} stats={statsLabel} />

      {/* Status states */}
      {status.kind === "loading" && (
        <p className="px-6 py-4 text-[12px] text-muted-foreground">Loading…</p>
      )}
      {status.kind === "error" && (
        <p className="px-6 py-4 text-[12px] text-destructive">
          Failed to read file: {(status as { kind: "error"; message: string }).message}
        </p>
      )}
      {status.kind === "binary" && (
        <p className="px-6 py-4 text-[12px] text-muted-foreground">
          Binary file — cannot render as spreadsheet.
        </p>
      )}
      {status.kind === "toolarge" && (
        <p className="px-6 py-4 text-[12px] text-muted-foreground">
          File is {(status as { kind: "toolarge"; size: number; limit: number }).size} bytes; limit{" "}
          {(status as { kind: "toolarge"; size: number; limit: number }).limit}.
        </p>
      )}

      {/* Table — split header (fixed) + body (scrollable) */}
      {status.kind === "ready" && (
        <>
          {/* Fixed header */}
          {header && (
            <div className="shrink-0 pt-10">
              <table
                className="min-w-max border-separate border-spacing-0 text-[12px] leading-none select-none"
                style={{ tableLayout: "fixed" }}
              >
                <colgroup>
                  {/* row-number gutter */}
                  <col style={{ width: "3.5rem", minWidth: "3.5rem" }} />
                  {Array.from({ length: colCount }).map((_, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable col index
                    <col key={ci} style={{ minWidth: "8rem" }} />
                  ))}
                </colgroup>
                <thead style={{ height: HEADER_HEIGHT }}>
                  <tr>
                    <th
                      scope="col"
                      className="border-b border-r border-border/50 bg-muted/80 px-2 text-right text-[10px] font-medium tabular-nums text-muted-foreground/50 backdrop-blur select-none"
                      style={{ height: HEADER_HEIGHT }}
                    />
                    {Array.from({ length: colCount }).map((_, ci) => {
                      const cell = header[ci] ?? "";
                      const isEditing = editing?.row === -1 && editing?.col === ci;
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: stable col index
                        <th
                          key={ci}
                          scope="col"
                          className="border-b border-r border-border/50 bg-muted/80 px-0 text-left font-semibold backdrop-blur"
                          style={{ height: HEADER_HEIGHT, color: colColor(ci) }}
                          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: spreadsheet header
                          onDoubleClick={(e) => handleCellDoubleClick(e, true, 0, ci)}
                        >
                          {isEditing ? (
                            <input
                              ref={editInputRef}
                              className="h-full w-full bg-accent/30 px-3 text-[12px] text-foreground outline-none ring-2 ring-inset ring-primary/50"
                              defaultValue={editing.value}
                              style={{ height: HEADER_HEIGHT }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === "Tab") {
                                  e.preventDefault();
                                  commitEdit(-1, ci, e.currentTarget.value);
                                } else if (e.key === "Escape") {
                                  cancelEdit();
                                }
                              }}
                              onBlur={(e) => commitEdit(-1, ci, e.currentTarget.value)}
                            />
                          ) : (
                            <span className="block truncate px-3">
                              {cell || (
                                <span className="text-muted-foreground/40">
                                  {String.fromCharCode(65 + ci)}
                                </span>
                              )}
                            </span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
              </table>
            </div>
          )}

          {/* Scrollable body */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click-to-deselect on container */}
          <div
            ref={scrollContainerRef}
            className={cn(
              "scrollbar-visible flex-1 overflow-auto outline-none",
              !header && "pt-10",
            )}
            onScroll={onScroll}
            // Deselect on backdrop click
            onClick={(e) => {
              if (e.target === scrollContainerRef.current) setSelection(null);
            }}
            // Allow keyboard events to bubble from child inputs
            tabIndex={-1}
          >
            <table
              className="min-w-max border-separate border-spacing-0 text-[12px] leading-none select-none"
              style={{ tableLayout: "fixed" }}
            >
              <colgroup>
                {/* row-number gutter */}
                <col style={{ width: "3.5rem", minWidth: "3.5rem" }} />
                {Array.from({ length: colCount }).map((_, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable col index
                  <col key={ci} style={{ minWidth: "8rem" }} />
                ))}
              </colgroup>

              <tbody>
                {/* Top padding spacer for virtual scrolling */}
                {paddingTop > 0 && (
                  <tr aria-hidden style={{ height: paddingTop }}>
                    <td colSpan={colCount + 1} />
                  </tr>
                )}

                {visibleRows.map((row, localIdx) => {
                  const ri = startIdx + localIdx;
                  const isRowSelected =
                    selection !== null &&
                    (() => {
                      const { minRow, maxRow } = normalizeRange(selection);
                      return ri >= minRow && ri <= maxRow;
                    })();

                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: virtual row index
                    <tr
                      key={ri}
                      className={cn(
                        "group/row transition-colors",
                        isRowSelected ? "bg-primary/8" : "hover:bg-accent/40",
                      )}
                      style={{ height: ROW_HEIGHT }}
                    >
                      {/* Row number */}
                      <td
                        className="border-b border-r border-border/30 bg-muted/30 px-2 text-right text-[10px] tabular-nums text-muted-foreground/40 select-none group-hover/row:bg-muted/50"
                        style={{ height: ROW_HEIGHT }}
                      >
                        {ri + 1}
                      </td>

                      {Array.from({ length: colCount }).map((_, ci) => {
                        const isSelected = cellInRange(ri, ci, selection);
                        const isEditing =
                          editing?.row === ri && editing?.col === ci;

                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: stable col index
                          <td
                            key={ci}
                            className={cn(
                              "relative border-b border-r border-border/30 px-0",
                              isSelected &&
                                "ring-1 ring-inset ring-primary/40 bg-primary/10",
                            )}
                            style={{ height: ROW_HEIGHT, color: colColor(ci) }}
                            onClick={(e) => handleCellClick(e, ri, ci)}
                            onDoubleClick={(e) =>
                              handleCellDoubleClick(e, false, ri, ci)
                            }
                          >
                            {isEditing ? (
                              <input
                                ref={editInputRef}
                                className="absolute inset-0 w-full bg-accent/30 px-3 text-[12px] text-foreground outline-none ring-2 ring-inset ring-primary/60"
                                style={{ height: ROW_HEIGHT }}
                                defaultValue={editing.value}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    commitEdit(ri, ci, e.currentTarget.value);
                                  } else if (e.key === "Tab") {
                                    e.preventDefault();
                                    commitEdit(ri, ci, e.currentTarget.value);
                                    // Move to next cell
                                    const nextCol = ci + 1 < colCount ? ci + 1 : 0;
                                    const nextRow = ci + 1 < colCount ? ri : Math.min(ri + 1, dataRows.length - 1);
                                    setSelection({ anchor: { row: nextRow, col: nextCol }, active: { row: nextRow, col: nextCol } });
                                  } else if (e.key === "Escape") {
                                    cancelEdit();
                                  }
                                }}
                                onBlur={(e) =>
                                  commitEdit(ri, ci, e.currentTarget.value)
                                }
                              />
                            ) : (
                              <span
                                className="block truncate px-3"
                                style={{ lineHeight: `${ROW_HEIGHT}px` }}
                                title={row[ci] ?? ""}
                              >
                                {row[ci] ?? ""}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}

                {/* Bottom padding spacer */}
                {paddingBottom > 0 && (
                  <tr aria-hidden style={{ height: paddingBottom }}>
                    <td colSpan={colCount + 1} />
                  </tr>
                )}

                {totalDataRows === 0 && (
                  <tr>
                    <td
                      colSpan={colCount + 1}
                      className="px-6 py-4 text-[12px] text-muted-foreground"
                    >
                      No data rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
