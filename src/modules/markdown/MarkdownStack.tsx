import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";
import { SplitPaneWrapper } from "@/modules/terminal/SplitPaneWrapper";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetMarkdownView: (id: number, mode: "rendered" | "raw") => void;
  registerTerminalHandle: (leafId: number, handle: any) => void;
  onSearchReady: (leafId: number, addon: any) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function MarkdownStack({
  tabs,
  activeId,
  onSetMarkdownView,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );
  if (markdowns.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
        const visible = t.id === activeId;
        const paneContent = (
          <MarkdownPreviewPane
            path={t.path}
            visible={visible}
            onSetView={(mode) => onSetMarkdownView(t.id, mode)}
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
