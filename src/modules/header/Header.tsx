import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { NotificationBell } from "@/modules/agents";
import { type Tab, MAX_PANES_PER_TAB } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import {
  Cancel01Icon,
  CommandIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Settings01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";
import { leafIds } from "@/modules/terminal/lib/panes";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  /** Promote a preview (transient) tab to persistent. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
  onActivateAgent: (tabId: number, leafId: number) => void;
  onActivateLocalAgent: () => void;
  onOpenSettings: () => void;
  spaceSwitcher: ReactNode;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClosePane: () => void;
};

const COMPACT_WIDTH = 720;

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onPin,
  onRename,
  onToggleSidebar,
  onOpenCommandPalette,
  onActivateAgent,
  onActivateLocalAgent,
  onOpenSettings,
  spaceSwitcher,
  searchTarget,
  searchRef,
  onSplitRight,
  onSplitDown,
  onClosePane,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminal = activeTab?.kind === "terminal" && !activeTab.blocks;
  const paneCount = isTerminal
    ? leafIds((activeTab as any).paneTree).length
    : 0;
  const canSplit = activeTab
    ? isTerminal
      ? paneCount < MAX_PANES_PER_TAB
      : !activeTab.split
    : false;
  const canClosePane = activeTab
    ? isTerminal
      ? paneCount > 1
      : !!activeTab.split
    : false;
  const showSplitControls =
    !!activeTab && !(activeTab.kind === "terminal" && activeTab.blocks);

  const settingsButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title="Settings"
    >
      <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
      }`}
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </Button>

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpenCommandPalette}
          title="Command palette"
          className="shrink-0 gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={CommandIcon} size={14} strokeWidth={1.75} />
        </Button>

        {!IS_MAC && (
          <NotificationBell
            onActivate={onActivateAgent}
            onActivateLocal={onActivateLocalAgent}
          />
        )}
      </div>

      {!IS_MAC && <span className="mx-1 h-full w-px shrink-0 bg-border/70" />}

      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border/70" />}

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {spaceSwitcher}
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onClose={onClose}
          onPin={onPin}
          onRename={onRename}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      {showSplitControls && (
        <div className="flex items-center gap-0.5 animate-in fade-in duration-200">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent"
            onClick={onSplitRight}
            disabled={!canSplit}
            title="Split Pane Right (Vertical Split)"
          >
            <HugeiconsIcon
              icon={LayoutTwoColumnIcon}
              size={15}
              strokeWidth={1.75}
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent"
            onClick={onSplitDown}
            disabled={!canSplit}
            title="Split Pane Down (Horizontal Split)"
          >
            <HugeiconsIcon
              icon={LayoutTwoRowIcon}
              size={15}
              strokeWidth={1.75}
            />
          </Button>
          {canClosePane && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={onClosePane}
              title="Close Active Pane"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.75} />
            </Button>
          )}
        </div>
      )}

      {/* Panel toggles — right side */}
      {settingsButton}

      {IS_MAC && (
        <NotificationBell
          onActivate={onActivateAgent}
          onActivateLocal={onActivateLocalAgent}
        />
      )}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
