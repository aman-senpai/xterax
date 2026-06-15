import { cn } from "@/lib/utils";
import type { CsvTab, Tab } from "@/modules/tabs";
import { SplitPaneWrapper } from "@/modules/terminal/SplitPaneWrapper";
import { CsvPreviewPane } from "./CsvPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetCsvView: (id: number, mode: "spreadsheet" | "raw") => void;
  registerTerminalHandle: (leafId: number, handle: any) => void;
  onSearchReady: (leafId: number, addon: any) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function CsvStack({
  tabs,
  activeId,
  onSetCsvView,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const csvTabs = tabs.filter(
    (t): t is CsvTab => t.kind === "csv" && !t.cold,
  );
  if (csvTabs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {csvTabs.map((t) => {
        const visible = t.id === activeId;
        const paneContent = (
          <CsvPreviewPane
            path={t.path}
            visible={visible}
            onSetView={(mode) => onSetCsvView(t.id, mode)}
          />
        );

        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            {t.split ? (
              <SplitPaneWrapper
                dir={t.split.dir}
                terminalLeafId={t.split.terminalLeafId}
                terminalCwd={t.split.terminalCwd}
                tabVisible={visible}
                registerTerminalHandle={registerTerminalHandle}
                onSearchReady={onSearchReady}
                onCwd={onCwd}
                onExit={onExit}
              >
                {paneContent}
              </SplitPaneWrapper>
            ) : (
              paneContent
            )}
          </div>
        );
      })}
    </div>
  );
}
