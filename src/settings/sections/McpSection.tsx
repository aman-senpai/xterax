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
  blankMcpServer,
  type McpServerConfig,
} from "@/modules/mcp/types";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setMcpServers } from "@/modules/settings/store";
import { SectionHeader } from "@/settings/components/SectionHeader";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
  McpServerIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function McpSection() {
  const servers = usePreferencesStore((s) => s.mcpServers);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);

  return (
    <div className="flex flex-col gap-7">
      <SectionHeader
        title="MCP Servers"
        description="Model Context Protocol servers that provide additional tools to the
        AI. Configure a server, then enable it to expose its tools."
      />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>Configured servers</Label>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => setEditing(blankMcpServer())}
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
            Add server
          </Button>
        </div>

        {servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-6 text-center text-[11px] text-muted-foreground">
            No MCP servers configured. Add one to extend the AI with custom
            tools.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {servers.map((srv) => (
              <ServerCard
                key={srv.id}
                server={srv}
                onToggle={(enabled) => {
                  const next = servers.map((s) =>
                    s.id === srv.id ? { ...s, enabled } : s,
                  );
                  void setMcpServers(next);
                }}
                onEdit={() => setEditing(srv)}
                onDelete={() => {
                  const next = servers.filter((s) => s.id !== srv.id);
                  void setMcpServers(next);
                }}
              />
            ))}
          </div>
        )}
      </section>

      <ServerEditorDialog
        server={editing}
        existing={servers}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          const exists = servers.some((s) => s.id === draft.id);
          const next = exists
            ? servers.map((s) => (s.id === draft.id ? draft : s))
            : [...servers, draft];
          void setMcpServers(next);
          setEditing(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Server card
// ---------------------------------------------------------------------------

function ServerCard({
  server,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServerConfig;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1.5 rounded-lg border bg-card/60 px-3 py-2.5 transition-colors",
        server.enabled
          ? "border-foreground/30 ring-1 ring-foreground/10"
          : "border-border/60 hover:border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/40">
          <HugeiconsIcon icon={McpServerIcon} size={14} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-medium">
            {server.name || "Unnamed server"}
          </span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {server.command || "No command set"}
            {server.args.length > 0 ? ` ${server.args.join(" ")}` : ""}
          </span>
        </div>
      </div>

      <div className="mt-0.5 flex items-center justify-between gap-1">
        <div className="flex items-center gap-1.5">
          <Switch
            checked={server.enabled}
            onCheckedChange={onToggle}
            size="sm"
          />
          <span className="text-[10.5px] text-muted-foreground">
            {server.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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

function ServerEditorDialog({
  server,
  existing,
  onClose,
  onSave,
}: {
  server: McpServerConfig | null;
  existing: McpServerConfig[];
  onClose: () => void;
  onSave: (draft: McpServerConfig) => void;
}) {
  const [draft, setDraft] = useState<McpServerConfig | null>(server);
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    if (!server) return;
    setDraft(server);
    // Serialise env object to KEY=VALUE lines for the textarea.
    setEnvText(
      Object.entries(server.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
  }, [server]);

  if (!draft) return null;

  const isNew = !existing.some((s) => s.id === draft.id);
  const canSave = draft.name.trim().length > 0 && draft.command.trim().length > 0;

  function commit() {
    // Parse env text back to object.
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) env[key] = val;
    }
    onSave({ ...draft, env } as McpServerConfig);
  }

  return (
    <Dialog open={!!server} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[14px]">
            {isNew ? "Add MCP server" : "Edit MCP server"}
          </DialogTitle>
        </DialogHeader>

        <div className="-mx-2 max-h-[calc(100vh-14rem)] overflow-y-auto px-2 flex flex-col gap-3">
          {/* Name */}
          <div className="flex flex-col gap-1">
            <Label>Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Filesystem server"
              className="h-8 text-[12px]"
            />
          </div>

          {/* Command */}
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <Label>Command</Label>
              <Input
                value={draft.command}
                onChange={(e) =>
                  setDraft({ ...draft, command: e.target.value })
                }
                placeholder="e.g. npx"
                className="h-8 font-mono text-[11.5px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Arguments</Label>
              <Input
                value={draft.args.join(" ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    args: e.target.value
                      .split(" ")
                      .map((a) => a.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="e.g. -y @modelcontextprotocol/server-filesystem /tmp"
                className="h-8 font-mono text-[11.5px]"
              />
            </div>
          </div>

          {/* Environment variables */}
          <div className="flex flex-col gap-1">
            <Label>Environment variables</Label>
            <Textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="KEY=value&#10;ANOTHER_KEY=another_value"
              className="min-h-28 resize-y font-mono text-[11px] leading-relaxed"
            />
            <span className="text-[10px] text-muted-foreground">
              One <code className="rounded bg-muted/50 px-0.5">KEY=VALUE</code>{" "}
              per line. Leave empty for none.
            </span>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-card/40 px-3 py-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-[12px] font-medium">Enable server</span>
              <span className="text-[10.5px] text-muted-foreground">
                Auto-connect when the app starts
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
// Helpers
// ---------------------------------------------------------------------------

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}
