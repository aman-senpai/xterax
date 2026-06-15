import type { GitHistoryTab, Tab } from "@/modules/tabs";
import { GitHistoryPane, type GitHistorySearchHandle } from "./GitHistoryPane";
import { SplitPaneWrapper } from "@/modules/terminal/SplitPaneWrapper";

type CommitFileDiffOpenInput = {
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenCommitFile: (input: CommitFileDiffOpenInput) => void;
  onSearchHandle?: (handle: GitHistorySearchHandle | null) => void;
  registerTerminalHandle: (leafId: number, handle: any) => void;
  onSearchReady: (leafId: number, addon: any) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function GitHistoryStack({
  tabs,
  activeId,
  onOpenCommitFile,
  onSearchHandle,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const active = tabs.find(
    (t): t is GitHistoryTab => t.kind === "git-history" && t.id === activeId,
  );
  if (!active) return null;

  const paneContent = (
    <GitHistoryPane
      key={active.id}
      repoRoot={active.repoRoot}
      onOpenCommitFile={onOpenCommitFile}
      onSearchHandle={onSearchHandle}
    />
  );

  return active.split ? (
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
  );
}
