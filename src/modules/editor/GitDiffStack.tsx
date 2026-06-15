import type { GitCommitFileDiffTab, GitDiffTab, Tab } from "@/modules/tabs";
import { GitDiffPane } from "./GitDiffPane";
import { SplitPaneWrapper } from "@/modules/terminal/SplitPaneWrapper";

type Props = {
  tabs: Tab[];
  activeId: number;
  registerTerminalHandle: (leafId: number, handle: any) => void;
  onSearchReady: (leafId: number, addon: any) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function GitDiffStack({
  tabs,
  activeId,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const active = tabs.find(
    (t): t is GitDiffTab | GitCommitFileDiffTab =>
      (t.kind === "git-diff" || t.kind === "git-commit-file") &&
      t.id === activeId,
  );
  if (!active) return null;

  const paneContent = active.kind === "git-diff" ? (
    <GitDiffPane
      key={active.id}
      active
      source={{
        kind: "working",
        repoRoot: active.repoRoot,
        path: active.path,
        mode: active.mode,
        originalPath: active.originalPath,
      }}
    />
  ) : (
    <GitDiffPane
      key={active.id}
      active
      source={{
        kind: "commit",
        repoRoot: active.repoRoot,
        sha: active.sha,
        path: active.path,
        originalPath: active.originalPath,
      }}
      chipLabel={active.shortSha}
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
