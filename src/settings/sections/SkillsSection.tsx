import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  blankSkill,
  skillIdFromName,
  type SkillConfig,
} from "@/modules/skills/types";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setSkillsConfigs } from "@/modules/settings/store";
import { SectionHeader } from "@/settings/components/SectionHeader";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  PuzzleIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function SkillsSection() {
  const configs = usePreferencesStore((s) => s.skillsConfigs);
  const [editing, setEditing] = useState<SkillConfig | null>(null);
  const [viewing, setViewing] = useState<SkillConfig | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="Agent Skills"
        description="Skills provide the AI with specialized instructions for specific
        tasks. Enable or disable skills, or create custom ones with inline
        content."
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Configured skills</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => setEditing(blankSkill())}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add skill
          </Button>
        </div>

        {configs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No skills configured. Skills discovered from your project's{" "}
            <code className="rounded bg-muted/50 px-1">.xterax/skills/</code>{" "}
            and{" "}
            <code className="rounded bg-muted/50 px-1">.agents/skills/</code>{" "}
            directories will appear here. Add a custom skill to extend the AI
            with tailored instructions.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {configs.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onToggle={(enabled) => {
                  const next = configs.map((s) =>
                    s.id === skill.id ? { ...s, enabled } : s,
                  );
                  void setSkillsConfigs(next);
                }}
                onEdit={() => setEditing(skill)}
                onView={() => setViewing(skill)}
                onDelete={() => {
                  const next = configs.filter((s) => s.id !== skill.id);
                  void setSkillsConfigs(next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <SkillEditorDialog
        skill={editing}
        existing={configs}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          const exists = configs.some((s) => s.id === draft.id);
          const next = exists
            ? configs.map((s) => (s.id === draft.id ? draft : s))
            : [...configs, draft];
          void setSkillsConfigs(next);
          setEditing(null);
        }}
      />

      <SkillViewDialog
        skill={viewing}
        onClose={() => setViewing(null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skill card
// ---------------------------------------------------------------------------

function SkillCard({
  skill,
  onToggle,
  onEdit,
  onView,
  onDelete,
}: {
  skill: SkillConfig;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onView: () => void;
  onDelete: () => void;
}) {
  const sourceLabel =
    skill.source === "project"
      ? "Project"
      : skill.source === "user"
        ? "User"
        : "Custom";

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        skill.enabled
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={PuzzleIcon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-medium">
            {skill.name || "Unnamed skill"}
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            {skill.description || "No description"}
          </span>
        </div>
      </div>

      <div className="mt-0.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          <Switch
            checked={skill.enabled}
            onCheckedChange={onToggle}
            size="sm"
          />
          <span className="text-[10.5px] text-muted-foreground">
            {skill.enabled ? "Enabled" : "Disabled"}
          </span>
          <span className="ml-1 rounded bg-muted/50 px-1 py-px font-mono text-[9px] text-muted-foreground">
            {sourceLabel}
          </span>
        </div>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {skill.content && (
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={onView}
              title="View content"
            >
              <HugeiconsIcon icon={ViewIcon} size={11} strokeWidth={1.75} />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            onClick={onEdit}
            title="Edit"
          >
            <HugeiconsIcon icon={Edit02Icon} size={11} strokeWidth={1.75} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-6 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            title="Delete"
          >
            <HugeiconsIcon icon={Delete02Icon} size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------

function SkillEditorDialog({
  skill,
  existing,
  onClose,
  onSave,
}: {
  skill: SkillConfig | null;
  existing: SkillConfig[];
  onClose: () => void;
  onSave: (draft: SkillConfig) => void;
}) {
  const [draft, setDraft] = useState<SkillConfig | null>(skill);

  useEffect(() => {
    if (!skill) return;
    setDraft(skill);
  }, [skill]);

  if (!draft) return null;

  const isNew = !existing.some((s) => s.id === draft.id);
  const canSave = draft.name.trim().length > 0 && draft.description.trim().length > 0;

  function commit() {
    if (!draft) return;
    // Auto-derive stable id from name for new skills so they match across
    // discovery cycles.
    const id = isNew ? skillIdFromName(draft.name.trim()) : draft.id;
    onSave({ ...draft, id } as SkillConfig);
  }

  return (
    <Dialog open={!!skill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "Add skill" : "Edit skill"}
          </DialogTitle>
        </DialogHeader>

        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. code-review"
              className="h-8 text-[12px]"
            />
            <span className="text-[10px] text-muted-foreground">
              Lowercase, hyphen-separated. Must be unique.
            </span>
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1">
            <Label>Description</Label>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="e.g. Review code changes for bugs and style issues"
              className="h-8 text-[12px]"
            />
            <span className="text-[10px] text-muted-foreground">
              Shown in the skill catalog. Used by the AI to decide when to
              activate this skill.
            </span>
          </div>

          {/* Content (custom skills only, or override for discovered) */}
          <div className="flex flex-col gap-1">
            <Label>
              Instructions{" "}
              <span className="text-[10px] text-muted-foreground">
                (Markdown)
              </span>
            </Label>
            <Textarea
              value={draft.content ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, content: e.target.value })
              }
              placeholder="Write the skill instructions in markdown…"
              className="min-h-36 resize-y font-mono text-[11px] leading-relaxed"
            />
            <span className="text-[10px] text-muted-foreground">
              For filesystem skills, this overrides the SKILL.md content. Leave
              empty to use the file content.
            </span>
          </div>

          {/* Source */}
          <div className="flex flex-col gap-1">
            <Label>Source</Label>
            <div className="flex gap-2">
              {(["project", "user", "custom"] as const).map((src) => (
                <Button
                  key={src}
                  size="sm"
                  variant={draft.source === src ? "default" : "outline"}
                  className="h-7 px-3 text-[11px] capitalize"
                  onClick={() => setDraft({ ...draft, source: src })}
                >
                  {src}
                </Button>
              ))}
            </div>
          </div>

          {/* Location (for filesystem skills) */}
          {(draft.source === "project" || draft.source === "user") && (
            <div className="flex flex-col gap-1">
              <Label>Location (optional)</Label>
              <Input
                value={draft.location ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, location: e.target.value || undefined })
                }
                placeholder="e.g. /path/to/project/.xterax/skills/my-skill/SKILL.md"
                className="h-8 font-mono text-[11px]"
              />
            </div>
          )}

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">Enable skill</span>
              <span className="text-[10.5px] text-muted-foreground">
                Include this skill in the AI's catalog
              </span>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={commit}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// View dialog (read-only content)
// ---------------------------------------------------------------------------

function SkillViewDialog({
  skill,
  onClose,
}: {
  skill: SkillConfig | null;
  onClose: () => void;
}) {
  if (!skill) return null;

  return (
    <Dialog open={!!skill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {skill.name || "Unnamed skill"}
          </DialogTitle>
        </DialogHeader>

        <div className="-mx-2 max-h-[calc(100vh-16rem)] overflow-y-auto px-2">
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
            {skill.content || "(No content)"}
          </pre>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
