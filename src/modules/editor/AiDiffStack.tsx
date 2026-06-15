import type { AiDiffTab, Tab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";
import { SplitPaneWrapper } from "@/modules/terminal/SplitPaneWrapper";

type Props = {
  tabs: Tab[];
  activeId: number;
  onAccept: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
  registerTerminalHandle: (leafId: number, handle: any) => void;
  onSearchReady: (leafId: number, addon: any) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function AiDiffStack({
  tabs,
  activeId,
  onAccept,
  onReject,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const active = tabs.find(
    (t): t is AiDiffTab => t.kind === "ai-diff" && t.id === activeId,
  );
  if (!active) return null;

  const paneContent = (
    <AiDiffPane
      key={active.id}
      path={active.path}
      originalContent={active.originalContent}
      proposedContent={active.proposedContent}
      status={active.status}
      isNewFile={active.isNewFile}
      onAccept={() => onAccept(active.approvalId)}
      onReject={() => onReject(active.approvalId)}
    />
  );

  return (
    <div className="h-full w-full">
      {active.split ? (
        <SplitPaneWrapper
          dir={active.split.dir}
          terminalLeafId={active.split.terminalLeafId}
          terminalCwd={active.split.terminalCwd}
          tabVisible={true}
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
}
