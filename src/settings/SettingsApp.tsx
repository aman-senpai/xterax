import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { SettingsTab } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AiScanIcon,
  InformationCircleIcon,
  KeyboardIcon,
  McpServerIcon,
  PaintBoardIcon,
  PuzzleIcon,
  RobotIcon,
  Settings01Icon,
  ShieldIcon,
  TextIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type JSX, useEffect, useState } from "react";
import { AboutSection } from "./sections/AboutSection";
import { AcpSection } from "./sections/AcpSection";
import { AgentsSection } from "./sections/AgentsSection";
import { GeneralSection } from "./sections/GeneralSection";
import { McpSection } from "./sections/McpSection";
import { ModelsSection } from "./sections/ModelsSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { PromptsSection } from "./sections/PromptsSection";
import { ShortcutsSection } from "./sections/ShortcutsSection";
import { SkillsSection } from "./sections/SkillsSection";
import { ThemesSection } from "./sections/ThemesSection";

const TABS: {
  id: SettingsTab;
  label: string;
  icon: typeof Settings01Icon;
  component: () => JSX.Element;
}[] = [
  {
    id: "general",
    label: "General",
    icon: Settings01Icon,
    component: GeneralSection,
  },
  {
    id: "themes",
    label: "Themes",
    icon: PaintBoardIcon,
    component: ThemesSection,
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: KeyboardIcon,
    component: ShortcutsSection,
  },
  {
    id: "permissions",
    label: "Permissions",
    icon: ShieldIcon,
    component: PermissionsSection,
  },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  {
    id: "agents",
    label: "Agents",
    icon: UserMultiple02Icon,
    component: AgentsSection,
  },
  {
    id: "prompts",
    label: "Prompts",
    icon: TextIcon,
    component: PromptsSection,
  },
  {
    id: "mcp",
    label: "MCP",
    icon: McpServerIcon,
    component: McpSection,
  },
  {
    id: "acp",
    label: "ACP",
    icon: RobotIcon,
    component: AcpSection,
  },
  {
    id: "skills",
    label: "Skills",
    icon: PuzzleIcon,
    component: SkillsSection,
  },
  {
    id: "about",
    label: "About",
    icon: InformationCircleIcon,
    component: AboutSection,
  },
];

const VALID_TABS: SettingsTab[] = [
  "general",
  "themes",
  "shortcuts",
  "permissions",
  "models",
  "agents",
  "prompts",
  "mcp",
  "acp",
  "skills",
  "about",
];

function readInitialTab(): SettingsTab {
  if (typeof window === "undefined") return "general";
  const url = new URL(window.location.href);
  const t = url.searchParams.get("tab");
  // Back-compat: legacy "ai" / "connections" → "models".
  if (t === "ai" || t === "connections") return "models";
  if (t && (VALID_TABS as string[]).includes(t)) return t as SettingsTab;
  return "general";
}

export function SettingsApp() {
  const [active, setActive] = useState<SettingsTab>(readInitialTab);
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = TABS.find((t) => t.id === active)?.component;

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const apply = (detail: string) => {
      if (detail === "ai" || detail === "connections") {
        setActive("models");
        return;
      }
      if ((VALID_TABS as string[]).includes(detail)) {
        setActive(detail as SettingsTab);
      }
    };
    const unlistenPromise = getCurrentWebviewWindow().listen<string>(
      "xterax:settings-tab",
      (e) => apply(e.payload),
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground select-none">
      <header
        data-tauri-drag-region
        className={cn(
          "flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60",
          IS_MAC ? "pr-3 pl-22" : "pr-0 pl-4",
        )}
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 flex-1 items-center"
        >
          <span
            data-tauri-drag-region
            className="text-[13px] font-semibold tracking-tight text-foreground/90"
          >
            Settings
          </span>
        </div>
        {USE_CUSTOM_WINDOW_CONTROLS && <WindowControls closeOnly />}
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 bg-card/40 px-2 py-3 scrollbar-visible"
        >
          {TABS.map((t) => {
            const isActive = t.id === active;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setActive(t.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  "outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isActive
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={t.icon}
                  size={14}
                  strokeWidth={1.75}
                  className="shrink-0 opacity-90"
                />
                <span className="min-w-0 truncate">{t.label}</span>
              </button>
            );
          })}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-8 pt-6 pb-8 scrollbar-visible">
          <div className="mx-auto w-full max-w-160">
            {ActiveSection && <ActiveSection />}
          </div>
        </main>
      </div>
    </div>
  );
}
