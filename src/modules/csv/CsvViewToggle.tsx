import { cn } from "@/lib/utils";

type Mode = "spreadsheet" | "raw";

type Props = {
  mode: Mode;
  onChange: (mode: Mode) => void;
  spreadsheetDisabled?: boolean;
  spreadsheetHint?: string;
  /** Optional "NNN rows · M cols" label shown to the left of the buttons. */
  stats?: string;
};

export function CsvViewToggle({
  mode,
  onChange,
  spreadsheetDisabled,
  spreadsheetHint,
  stats,
}: Props) {
  return (
    <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-0.5 rounded-md border border-border/60 bg-card/85 p-0.5 text-[11px] shadow-sm backdrop-blur">
      {stats && (
        <span className="px-2 text-[10px] tabular-nums text-muted-foreground/70 select-none">
          {stats}
        </span>
      )}
      <button
        type="button"
        onClick={() => onChange("spreadsheet")}
        disabled={spreadsheetDisabled}
        title={spreadsheetDisabled ? spreadsheetHint : undefined}
        className={cn(
          "rounded px-2 py-0.5 transition-colors",
          mode === "spreadsheet"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
          spreadsheetDisabled &&
            "cursor-not-allowed opacity-40 hover:text-muted-foreground",
        )}
      >
        Spreadsheet
      </button>
      <button
        type="button"
        onClick={() => onChange("raw")}
        className={cn(
          "rounded px-2 py-0.5 transition-colors",
          mode === "raw"
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Raw
      </button>
    </div>
  );
}
