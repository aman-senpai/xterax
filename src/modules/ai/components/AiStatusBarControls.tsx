import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AppleIcon,
  ArrowDown01Icon,
  ChatGptIcon,
  ClaudeIcon,
  ComputerIcon,
  CpuIcon,
  DeepseekIcon,
  FavouriteIcon,
  FlashIcon,
  GlobeIcon,
  GoogleGeminiIcon,
  Grok02Icon,
  MistralIcon,
  PlugIcon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  SparklesIcon,
  StarIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useRef, useState } from "react";
import {
  compatModelIdForEndpoint,
  getCompatModelInfo,
  getModel,
  isCompatModelId,
  MODELS,
  type ModelId,
  type ModelInfo,
  PROVIDERS,
  type ProviderId,
  providerNeedsKey,
} from "../config";
import { toggleFavoriteModel } from "../lib/modelPrefs";
import { useChatStore } from "../store/chatStore";

const PROVIDER_ICON = {
  openai: ChatGptIcon,
  anthropic: ClaudeIcon,
  google: GoogleGeminiIcon,
  xai: Grok02Icon,
  cerebras: CpuIcon,
  groq: FlashIcon,
  deepseek: DeepseekIcon,
  mistral: MistralIcon,
  openrouter: GlobeIcon,
  "openai-compatible": PlugIcon,
  lmstudio: ComputerIcon,
  mlx: AppleIcon,
  ollama: ServerStack01Icon,
} as const satisfies Record<ProviderId, typeof ChatGptIcon>;

export function AiOpenButton({
  onClick,
  active,
}: {
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md border px-1.5 text-xs transition-colors",
        active
          ? "border-border bg-accent text-foreground"
          : "border-border/60 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
        "animate-in slide-in-from-top-2 duration-200 ease-out",
      )}
      title="Toggle AI agent"
    >
      <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
      <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
    </button>
  );
}

export function AiStatusBarControls() {
  return null;
}

// Module-level selectors — stable references to avoid Zustand v5
// useSyncExternalStore consistency-check re-renders on array/object returns.
const selectSelectedModelId = (s: ReturnType<typeof useChatStore.getState>) =>
  s.selectedModelId;
const selectApiKeys = (s: ReturnType<typeof useChatStore.getState>) =>
  s.apiKeys;
const selectSetSelectedModelId = (
  s: ReturnType<typeof useChatStore.getState>,
) => s.setSelectedModelId;
const selectFavoriteModelIds = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.favoriteModelIds;
const selectCustomEndpoints = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.customEndpoints;

export function ModelDropdown({ compact = false }: { compact?: boolean }) {
  const selected = useChatStore(selectSelectedModelId);
  const apiKeys = useChatStore(selectApiKeys);
  const setSelected = useChatStore(selectSetSelectedModelId);
  const favoriteIds = usePreferencesStore(selectFavoriteModelIds);
  const customEndpoints = usePreferencesStore(selectCustomEndpoints);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const openrouterModelId = usePreferencesStore((s) => s.openrouterModelId);
  const current = isCompatModelId(selected)
    ? getCompatModelInfo(selected, customEndpoints)
    : getModel(selected as ModelId);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isProviderConfigured = (id: ProviderId): boolean => {
    if (id === "openrouter") return !!apiKeys[id] && !!openrouterModelId.trim();
    if (providerNeedsKey(id)) return !!apiKeys[id];
    if (id === "lmstudio") return !!lmstudioModelId.trim();
    if (id === "mlx") return !!mlxModelId.trim();
    if (id === "ollama") return !!ollamaModelId.trim();
    return false;
  };

  const currentProviderHasKey = isCompatModelId(selected)
    ? true
    : isProviderConfigured(current.provider);

  const epModelInfos = useMemo(() => {
    return customEndpoints.map((ep) =>
      getCompatModelInfo(compatModelIdForEndpoint(ep.id), customEndpoints),
    );
  }, [customEndpoints]);

  const configuredProviderIds = useMemo(() => {
    const ids = new Set<ProviderId>();
    for (const p of PROVIDERS) {
      if (p.id === "openai-compatible") continue;
      if (isProviderConfigured(p.id)) ids.add(p.id);
    }
    return ids;
  }, [apiKeys, lmstudioModelId, mlxModelId, ollamaModelId, openrouterModelId]);

  const configuredProviders = useMemo(() => {
    return PROVIDERS.filter(
      (p) => p.id !== "openai-compatible" && configuredProviderIds.has(p.id),
    );
  }, [configuredProviderIds]);

  const allModels = useMemo(() => {
    const builtIn = MODELS.filter((m) => configuredProviderIds.has(m.provider));
    return [...builtIn, ...epModelInfos];
  }, [configuredProviderIds, epModelInfos]);

  const q = search.trim().toLowerCase();

  // When searching: flat filtered list. Otherwise: grouped by section.
  const sections = useMemo(() => {
    const favs = q ? [] : allModels.filter((m) => favoriteIds.includes(m.id));
    const groups: {
      key: string;
      label: string;
      icon: typeof FavouriteIcon;
      models: ModelInfo[];
    }[] = [];
    if (favs.length > 0) {
      groups.push({
        key: "favorites",
        label: "Favorites",
        icon: FavouriteIcon,
        models: favs,
      });
    }
    for (const p of configuredProviders) {
      const models = allModels.filter((m) => m.provider === p.id);
      if (models.length > 0) {
        groups.push({
          key: p.id,
          label: p.label,
          icon: PROVIDER_ICON[p.id],
          models,
        });
      }
    }
    if (epModelInfos.length > 0 && !q) {
      groups.push({
        key: "__compat__",
        label: "OpenAI Compatible",
        icon: PlugIcon,
        models: epModelInfos,
      });
    }
    return groups;
  }, [allModels, favoriteIds, configuredProviders, epModelInfos, q]);

  const searchResults = useMemo(() => {
    if (!q) return [];
    return allModels.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.hint.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.provider.includes(q) ||
        ("tags" in m &&
          (m as ModelInfo).tags?.some((t: string) => t.includes(q))),
    );
  }, [allModels, q]);

  const searching = q.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-xs" : "sm"}
          className={cn(
            "shrink-0 rounded-md hover:bg-accent hover:text-foreground",
            compact
              ? "size-6"
              : "my-1 h-5.5 min-w-0 gap-1 overflow-hidden px-1.5 text-xs",
            currentProviderHasKey
              ? "text-muted-foreground"
              : "text-amber-600 dark:text-amber-400",
          )}
          title={
            currentProviderHasKey
              ? `Model: ${current.label}`
              : `${current.label} - no key configured`
          }
        >
          <HugeiconsIcon
            icon={PROVIDER_ICON[current.provider]}
            size={12}
            strokeWidth={1.5}
            className="shrink-0 text-muted-foreground/70"
          />
          {!compact ? (
            <>
              <span className="min-w-0 max-w-[7rem] truncate">
                {current.label}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                size={11}
                strokeWidth={2}
                className="shrink-0 opacity-70"
              />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-64 p-0 overflow-hidden rounded-xl border border-border/70 shadow-xl"
        onFocusCapture={(e) => {
          if (e.target !== inputRef.current) inputRef.current?.focus();
        }}
      >
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <HugeiconsIcon
            icon={Search01Icon}
            size={14}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/70"
          />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search models…"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Model list */}
        <div className="max-h-80 overflow-y-auto py-1">
          {searching ? (
            searchResults.length === 0 ? (
              <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground/70">
                No models match.
              </div>
            ) : (
              searchResults.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === selected}
                  favorite={favoriteIds.includes(m.id)}
                  onPick={() => setSelected(m.id)}
                  onToggleFavorite={() => void toggleFavoriteModel(m.id)}
                />
              ))
            )
          ) : sections.length === 0 ? (
            <div className="flex items-center justify-center px-4 py-10 text-xs text-muted-foreground/70">
              No models match.
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key}>
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-medium tracking-tight text-muted-foreground/90">
                  <HugeiconsIcon
                    icon={section.icon}
                    size={12}
                    strokeWidth={1.75}
                  />
                  <span>{section.label}</span>
                </div>
                {section.models.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === selected}
                    favorite={favoriteIds.includes(m.id)}
                    onPick={() => setSelected(m.id)}
                    onToggleFavorite={() => void toggleFavoriteModel(m.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-border/70 px-1.5 py-1">
          <button
            type="button"
            onClick={() => void openSettingsWindow("models")}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <HugeiconsIcon icon={Settings01Icon} size={12} strokeWidth={1.75} />
            <span>Configure providers…</span>
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModelRow({
  model,
  selected,
  favorite,
  onPick,
  onToggleFavorite,
}: {
  model: ModelInfo;
  selected: boolean;
  favorite: boolean;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "group mx-1 my-0.5 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5",
        selected ? "bg-accent/60 text-foreground" : "text-foreground/85",
      )}
    >
      <span className="flex-1 truncate text-[12px] font-medium leading-none">
        {model.label}
      </span>

      {/* Fixed-width container prevents layout shift on hover */}
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        {/* Checkmark — visible when selected, hidden on hover */}
        <HugeiconsIcon
          icon={Tick01Icon}
          size={13}
          strokeWidth={2}
          className={cn(
            "absolute text-foreground transition-opacity",
            selected ? "opacity-100 group-hover:opacity-0" : "opacity-0",
          )}
        />
        {/* Star — visible only on hover */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFavorite();
          }}
          title={favorite ? "Unfavorite" : "Favorite"}
          className="absolute rounded transition-opacity opacity-0 group-hover:opacity-100"
        >
          <HugeiconsIcon
            icon={StarIcon}
            size={11}
            strokeWidth={favorite ? 2 : 1.75}
            className={cn(
              "text-muted-foreground/50 hover:text-foreground/80",
              favorite &&
                "fill-foreground/60 text-foreground/60 hover:text-foreground/80",
            )}
          />
        </button>
      </span>
    </DropdownMenuItem>
  );
}
