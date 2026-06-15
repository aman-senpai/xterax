import type { Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

type LoaderResult = Extension | { token: unknown };
type LanguageLoader = () => Promise<LoaderResult>;

// ---------------------------------------------------------------------------
// Rainbow-CSV ViewPlugin — no external language pack required.
// ---------------------------------------------------------------------------

/** Split a CSV/TSV line into cell spans, honouring double-quoted fields. */
function parseCsvLine(
  text: string,
  sep: string,
): Array<{ from: number; to: number; col: number }> {
  const spans: Array<{ from: number; to: number; col: number }> = [];
  let col = 0;
  let i = 0;
  let cellStart = 0;
  const isTsv = sep === "\t";

  while (i <= text.length) {
    // Consume a quoted field (only for comma/dsv, not tsv)
    if (!isTsv && i < text.length && text[i] === '"') {
      i++; // skip opening quote
      while (i < text.length) {
        if (text[i] === '"') {
          i++;
          if (i < text.length && text[i] === '"') {
            i++; // escaped quote
          } else {
            break; // end of quoted field
          }
        } else {
          i++;
        }
      }
    }

    // Advance to next separator or end
    const sepIdx = text.indexOf(sep, i);
    const end = sepIdx === -1 ? text.length : sepIdx;

    spans.push({ from: cellStart, to: end, col: col % 10 });
    col++;

    if (sepIdx === -1) break;
    i = sepIdx + 1;
    cellStart = i;
  }
  return spans;
}

/** 10 distinct hues cycling through the spectrum. */
const RAINBOW_MARK = Array.from({ length: 10 }, (_, i) =>
  Decoration.mark({ class: `csv-col-${i}` }),
);

function buildDecorations(view: EditorView, sep: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      if (lineText.trim().length > 0) {
        const spans = parseCsvLine(lineText, sep);
        for (const { from: f, to: t, col } of spans) {
          const absFrom = line.from + f;
          const absTo = line.from + t;
          if (absFrom < absTo && absFrom >= from && absTo <= view.state.doc.length + 1) {
            builder.add(absFrom, absTo, RAINBOW_MARK[col]);
          }
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

function buildRainbowCsvExtension(sep: string): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, sep);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, sep);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const theme = EditorView.baseTheme({
    // Light-mode: rich saturated hues
    ".csv-col-0": { color: "oklch(0.48 0.18 25)" },   // red-orange
    ".csv-col-1": { color: "oklch(0.50 0.16 55)" },   // amber
    ".csv-col-2": { color: "oklch(0.48 0.17 145)" },  // green
    ".csv-col-3": { color: "oklch(0.50 0.18 240)" },  // blue
    ".csv-col-4": { color: "oklch(0.46 0.20 305)" },  // violet
    ".csv-col-5": { color: "oklch(0.50 0.17 185)" },  // cyan
    ".csv-col-6": { color: "oklch(0.52 0.18 340)" },  // pink
    ".csv-col-7": { color: "oklch(0.50 0.15 95)" },   // yellow-green
    ".csv-col-8": { color: "oklch(0.50 0.17 195)" },  // teal
    ".csv-col-9": { color: "oklch(0.46 0.16 270)" },  // indigo
    // Dark-mode overrides: lighter tints
    "&dark .csv-col-0, .dark &.csv-col-0, :is(.dark *) .csv-col-0": { color: "oklch(0.80 0.17 25)" },
    "&dark .csv-col-1, .dark &.csv-col-1, :is(.dark *) .csv-col-1": { color: "oklch(0.82 0.15 55)" },
    "&dark .csv-col-2, .dark &.csv-col-2, :is(.dark *) .csv-col-2": { color: "oklch(0.80 0.17 145)" },
    "&dark .csv-col-3, .dark &.csv-col-3, :is(.dark *) .csv-col-3": { color: "oklch(0.82 0.16 240)" },
    "&dark .csv-col-4, .dark &.csv-col-4, :is(.dark *) .csv-col-4": { color: "oklch(0.80 0.18 305)" },
    "&dark .csv-col-5, .dark &.csv-col-5, :is(.dark *) .csv-col-5": { color: "oklch(0.82 0.15 185)" },
    "&dark .csv-col-6, .dark &.csv-col-6, :is(.dark *) .csv-col-6": { color: "oklch(0.80 0.17 340)" },
    "&dark .csv-col-7, .dark &.csv-col-7, :is(.dark *) .csv-col-7": { color: "oklch(0.82 0.14 95)" },
    "&dark .csv-col-8, .dark &.csv-col-8, :is(.dark *) .csv-col-8": { color: "oklch(0.80 0.16 195)" },
    "&dark .csv-col-9, .dark &.csv-col-9, :is(.dark *) .csv-col-9": { color: "oklch(0.80 0.15 270)" },
  });

  return [plugin, theme];
}

const rubyLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/ruby").then((m) => m.ruby);

const jsonLoader: LanguageLoader = () =>
  import("@codemirror/lang-json").then((m) => m.json());

const sqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.standardSQL);
const pgsqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.pgSQL);
const mysqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.mySQL);
const sqliteLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.sqlite);
const mariadbLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.mariaDB);
const mssqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.msSQL);
const plsqlLoader: LanguageLoader = () =>
  import("@codemirror/legacy-modes/mode/sql").then((m) => m.plSQL);

/**
 * Extension → loader. Each loader is a dynamic import so language packs
 * only enter the bundle when a matching file is opened.
 *
 * Loaders may return either a ready Extension (lang-* packages) or a raw
 * StreamParser (legacy-modes). `resolveLanguage` wraps the latter in
 * StreamLanguage before returning.
 */
const loaders: Record<string, LanguageLoader> = {
  // JavaScript / TypeScript family
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true }),
    ),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  ts: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ typescript: true }),
    ),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),

  rs: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: jsonLoader,
  jsonc: jsonLoader,
  json5: jsonLoader,

  sql: sqlLoader,
  psql: pgsqlLoader,
  pgsql: pgsqlLoader,
  mysql: mysqlLoader,
  sqlite: sqliteLoader,
  mariadb: mariadbLoader,
  mssql: mssqlLoader,
  plsql: plsqlLoader,

  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),

  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  astro: () =>
    import("@codemirror/lang-html").then((m) =>
      m.html({ selfClosingTags: true }),
    ),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),

  php: () => import("@codemirror/lang-php").then((m) => m.php({ plain: true })),
  rb: rubyLoader,
  rake: rubyLoader,
  gemspec: rubyLoader,
  ru: rubyLoader,

  // C / C++ family
  c: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  h: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.c),
  cpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cc: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  cxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hpp: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),
  hxx: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.cpp),

  // Java
  java: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.java),

  // C#
  cs: () => import("@codemirror/legacy-modes/mode/clike").then((m) => m.csharp),

  // Swift
  swift: () =>
    import("@codemirror/legacy-modes/mode/swift").then((m) => m.swift),

  // Legacy-modes: loaders return the raw StreamParser; wrapped below.
  sh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  bash: () =>
    import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  zsh: () => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  yml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => m.yaml),
  dockerfile: () =>
    import("@codemirror/legacy-modes/mode/dockerfile").then(
      (m) => m.dockerFile,
    ),

  // LaTeX / TeX
  tex: () =>
    import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  latex: () =>
    import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  sty: () =>
    import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),
  cls: () =>
    import("@codemirror/legacy-modes/mode/stex").then((m) => m.stex),

  // CSV / TSV — rainbow column highlighting (no external dep)
  csv: () => Promise.resolve(buildRainbowCsvExtension(",")),
  tsv: () => Promise.resolve(buildRainbowCsvExtension("\t")),
  dsv: () => Promise.resolve(buildRainbowCsvExtension(",")),
};

const filenameOverrides: Record<string, LanguageLoader> = {
  dockerfile: loaders.dockerfile!,
  "dockerfile.dev": loaders.dockerfile!,
  gemfile: rubyLoader,
  rakefile: rubyLoader,
  podfile: rubyLoader,
  fastfile: rubyLoader,
  guardfile: rubyLoader,
  brewfile: rubyLoader,
};

function extOf(name: string): string | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1 || dot === lower.length - 1) return null;
  return lower.slice(dot + 1);
}

function isStreamParser(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { token?: unknown }).token === "function"
  );
}

const cache = new Map<string, Extension | null>();

function cacheKey(filename: string): string | null {
  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (filenameOverrides[base]) return `name:${base}`;
  const ext = extOf(base);
  return ext ? `ext:${ext}` : null;
}

export function resolveLanguageSync(filename: string): Extension | null {
  const key = cacheKey(filename);
  return key ? (cache.get(key) ?? null) : null;
}

export async function resolveLanguage(
  filename: string,
): Promise<Extension | null> {
  const key = cacheKey(filename);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const lower = filename.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  const loader = filenameOverrides[base] ?? loaders[extOf(base) ?? ""];
  if (!loader) {
    cache.set(key, null);
    return null;
  }

  const result = await loader();
  let ext: Extension;
  if (isStreamParser(result)) {
    const { StreamLanguage } = await import("@codemirror/language");
    ext = StreamLanguage.define(
      result as Parameters<typeof StreamLanguage.define>[0],
    );
  } else {
    ext = result as Extension;
  }
  cache.set(key, ext);
  return ext;
}

export function preloadLanguages(filenames: string[]): void {
  for (const f of filenames) {
    void resolveLanguage(f).catch(() => {});
  }
}
