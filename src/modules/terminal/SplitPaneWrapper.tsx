import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { SplitDir } from "./lib/panes";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import { useTerminalDropStore } from "./lib/dropStore";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useRef } from "react";

type Props = {
  children: React.ReactNode;
  dir: SplitDir;
  terminalLeafId: number;
  terminalCwd?: string;
  tabVisible: boolean;
  registerTerminalHandle: (
    leafId: number,
    handle: TerminalPaneHandle | null,
  ) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

export function SplitPaneWrapper({
  children,
  dir,
  terminalLeafId,
  terminalCwd,
  tabVisible,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onExit,
}: Props) {
  const registerRef = useRef(registerTerminalHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const exitRef = useRef(onExit);

  useEffect(() => {
    registerRef.current = registerTerminalHandle;
  }, [registerTerminalHandle]);

  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);

  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);

  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  return (
    <ResizablePanelGroup
      orientation={dir === "row" ? "horizontal" : "vertical"}
      className="h-full w-full"
    >
      <ResizablePanel defaultSize={50} minSize={10}>
        <div className="relative h-full w-full overflow-hidden">{children}</div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50} minSize={10}>
        <div className="relative h-full w-full bg-background rounded-md overflow-hidden border border-border/60">
          <TerminalPane
            leafId={terminalLeafId}
            visible={tabVisible}
            focused={tabVisible}
            initialCwd={terminalCwd}
            ref={(h) => registerRef.current(terminalLeafId, h)}
            onSearchReady={onSearchReady}
            onCwd={onCwd}
            onExit={onExit}
          />
          <DropOverlay leafId={terminalLeafId} />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      Drop file path here
    </div>
  );
}
