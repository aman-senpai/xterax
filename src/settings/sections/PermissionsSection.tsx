import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setPermissions,
  type ToolApprovalPolicy,
  type ToolPermissions,
} from "@/modules/settings/store";
import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const TOOL_LABELS: Record<keyof ToolPermissions, string> = {
  bash_run: "Run shell command",
  bash_background: "Spawn background process",
  write_file: "Write file",
  edit: "Edit file",
  multi_edit: "Batch edit file",
  create_directory: "Create directory",
  spawn_coding_agent: "Spawn coding agent",
  send_to_agent: "Send to agent",
};

const TOOL_DESCRIPTIONS: Record<keyof ToolPermissions, string> = {
  bash_run: "Execute arbitrary shell commands in the terminal.",
  bash_background: "Spawn a long-running child process that outlives the agent.",
  write_file: "Create or overwrite files on disk.",
  edit: "Apply surgical edits (insert, replace, delete) within existing files.",
  multi_edit: "Apply multiple edits across files in a single operation.",
  create_directory: "Create new directories on disk.",
  spawn_coding_agent: "Fork a child agent that runs its own coding loop.",
  send_to_agent: "Forward messages to another running agent.",
};

const POLICY_OPTIONS: { value: ToolApprovalPolicy; label: string }[] = [
  { value: "ask", label: "Ask each time" },
  { value: "auto-approve", label: "Auto-approve" },
  { value: "deny", label: "Always deny" },
];

export function PermissionsSection() {
  const permissions = usePreferencesStore((s) => s.permissions);

  const updateToolPermission = (
    tool: keyof ToolPermissions,
    policy: ToolApprovalPolicy,
  ) => {
    void setPermissions({
      ...permissions,
      toolPermissions: { ...permissions.toolPermissions, [tool]: policy },
    });
  };

  const updateAllowlistEntry = (index: number, pattern: string) => {
    const list = [...permissions.shellAllowlist];
    if (list[index]) {
      list[index] = { ...list[index], pattern };
      void setPermissions({ ...permissions, shellAllowlist: list });
    }
  };

  const toggleAllowlistEntry = (index: number) => {
    const list = [...permissions.shellAllowlist];
    if (list[index]) {
      list[index] = { ...list[index], enabled: !list[index].enabled };
      void setPermissions({ ...permissions, shellAllowlist: list });
    }
  };

  const removeAllowlistEntry = (index: number) => {
    const list = permissions.shellAllowlist.filter((_, i) => i !== index);
    void setPermissions({ ...permissions, shellAllowlist: list });
  };

  const addAllowlistEntry = () => {
    void setPermissions({
      ...permissions,
      shellAllowlist: [
        ...permissions.shellAllowlist,
        { pattern: "", enabled: false },
      ],
    });
  };

  const addDirectory = () => {
    void setPermissions({
      ...permissions,
      writableDirectories: [...permissions.writableDirectories, ""],
    });
  };

  const updateDirectory = (index: number, path: string) => {
    const dirs = [...permissions.writableDirectories];
    dirs[index] = path;
    void setPermissions({ ...permissions, writableDirectories: dirs });
  };

  const removeDirectory = (index: number) => {
    const dirs = permissions.writableDirectories.filter((_, i) => i !== index);
    void setPermissions({ ...permissions, writableDirectories: dirs });
  };

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Permissions"
        description="Control which tools the coding agent can use and how approval is handled."
      />

      {/* Tool Permissions */}
      <div className="flex flex-col gap-2">
        <Label>Tool Permissions</Label>
        <div className="flex flex-col gap-1.5">
          {(Object.keys(TOOL_LABELS) as Array<keyof ToolPermissions>).map(
            (tool) => (
              <SettingRow
                key={tool}
                title={TOOL_LABELS[tool]}
                description={TOOL_DESCRIPTIONS[tool]}
              >
                <Select
                  value={permissions.toolPermissions[tool]}
                  onValueChange={(v) =>
                    updateToolPermission(tool, v as ToolApprovalPolicy)
                  }
                >
                  <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {POLICY_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        className="text-[12px]"
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            ),
          )}
        </div>
      </div>

      {/* Shell Command Allowlist */}
      <div className="flex flex-col gap-2">
        <Label>Shell Command Allowlist</Label>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground -mt-1">
          Commands matching an enabled pattern will be auto-approved without a prompt.
        </p>
        <div className="flex flex-col gap-1.5">
          {permissions.shellAllowlist.map((entry, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
            >
              <Switch
                checked={entry.enabled}
                onCheckedChange={() => toggleAllowlistEntry(i)}
                className="shrink-0"
              />
              <Input
                type="text"
                value={entry.pattern}
                placeholder="e.g. npm test"
                onChange={(e) => updateAllowlistEntry(i, e.target.value)}
                className="h-7 flex-1 rounded border border-border/40 bg-background px-2 text-[12px] outline-none focus:border-foreground/40"
              />
              <button
                type="button"
                onClick={() => removeAllowlistEntry(i)}
                className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Remove pattern"
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={addAllowlistEntry}
          className="mt-1 h-7 gap-1.5 self-start text-[11px]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
          Add pattern
        </Button>
      </div>

      {/* Writable Directories */}
      <div className="flex flex-col gap-2">
        <Label>Writable Directories</Label>
        <p className="text-[10.5px] leading-relaxed text-muted-foreground -mt-1">
          File writes in these directories won't require per-file approval.
        </p>
        <div className="flex flex-col gap-1.5">
          {permissions.writableDirectories.map((dir, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
            >
              <Input
                type="text"
                value={dir}
                placeholder="/path/to/directory"
                onChange={(e) => updateDirectory(i, e.target.value)}
                className="h-7 flex-1 rounded border border-border/40 bg-background px-2 text-[12px] font-mono outline-none focus:border-foreground/40"
              />
              <button
                type="button"
                onClick={() => removeDirectory(i)}
                className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Remove directory"
              >
                <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={addDirectory}
          className="mt-1 h-7 gap-1.5 self-start text-[11px]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
          Add directory
        </Button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
