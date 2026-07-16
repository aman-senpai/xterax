import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ABSOLUTE_LOOP_MAX,
  clampLoopMax,
  DEFAULT_LOOP_MAX,
  formatLoopPreset,
  normalizePipelineLoopSettings,
  type PipelineLoopPreset,
  type PipelineLoopSettings,
  SYSTEM_LOOP_MAX,
} from "@/modules/ai/lib/pipelineDsl";
import { isValidHandle, normalizeHandle } from "@/modules/ai/lib/snippets";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setPipelineLoops } from "@/modules/settings/store";
import {
  Add01Icon,
  Delete02Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

const selectPipelineLoops = (
  s: ReturnType<typeof usePreferencesStore.getState>,
) => s.pipelineLoops;

function DocBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-[13px] font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="flex flex-col gap-2.5 text-[12px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border/60 bg-card/60 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground/90 whitespace-pre-wrap">
      {children}
    </pre>
  );
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-[11px] text-foreground/90">
      {children}
    </code>
  );
}

function Kwd({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-primary/10 px-1 py-0.5 font-mono text-[11px] text-primary">
      {children}
    </code>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px] font-medium tracking-tight text-foreground">
      {children}
    </span>
  );
}

export function WorkflowSection() {
  const pipelineLoops = usePreferencesStore(selectPipelineLoops);
  const [editingLoop, setEditingLoop] = useState<PipelineLoopPreset | null>(
    null,
  );

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Workflow"
        description="Chain agents, loop until checks pass, and save reusable pipeline templates. Type @handles in the composer to run a workflow."
      />

      <DocBlock title="Modes vs agents">
        <p>
          The composer dropdown picks a{" "}
          <strong className="font-medium text-foreground/90">mode</strong>{" "}
          (Default, Plan, Review, or custom). Modes set posture for the main
          Xterax agent.
        </p>
        <p>
          <strong className="font-medium text-foreground/90">Agents</strong> are
          specialists. Mention them with <InlineCode>@handle</InlineCode> to run
          a pipeline. Bare messages use the main agent under the active mode;
          messages with <InlineCode>@</InlineCode> mentions run the ordered
          workflow you wrote.
        </p>
        <p>
          Built-ins: <InlineCode>@coder</InlineCode>,{" "}
          <InlineCode>@architect</InlineCode>,{" "}
          <InlineCode>@reviewer</InlineCode>, <InlineCode>@security</InlineCode>
          , <InlineCode>@designer</InlineCode>,{" "}
          <InlineCode>@verification</InlineCode>. Configure agents under
          Settings → Agents; ACP agents under Settings → ACP.
        </p>
      </DocBlock>

      <DocBlock title="Chaining">
        <p>
          List agents in order. They run left to right; each step gets your
          brief plus summaries from previous steps.
        </p>
        <CodeBlock>{`@architect design a cache layer for the session store
@coder implement the plan
@verification run typecheck and tests`}</CodeBlock>
        <p>Arrows are optional and mean the same thing:</p>
        <CodeBlock>{`@architect -> @coder -> @verification fix the flaky auth test`}</CodeBlock>
        <p>
          Free text is the shared brief. Structure tokens (<Kwd>loop</Kwd>,{" "}
          <Kwd>break</Kwd>, arrows, handles) are stripped from the brief before
          agents run. Type <InlineCode>@</InlineCode> for the agent picker.
        </p>
      </DocBlock>

      <PipelineLoopsBlock
        settings={pipelineLoops}
        onChange={(next) => void setPipelineLoops(next)}
        onEdit={setEditingLoop}
      />

      <DocBlock title="Break conditions (structured only)">
        <p>
          After each loop body run, Xterax resolves a single structured outcome
          from the body steps. Natural-language phrases like &quot;all tests
          passed&quot; are ignored.
        </p>
        <ul className="list-disc space-y-1.5 pl-4">
          <li>
            <Kwd>break if pass</Kwd> (also <Kwd>ok</Kwd> / <Kwd>done</Kwd>):
            exit when the body outcome is pass
          </li>
          <li>
            <Kwd>break if fail</Kwd>: exit when the body outcome is fail
          </li>
          <li>
            <Kwd>break if always</Kwd>: run the body once then exit
          </li>
          <li>
            <Kwd>break if never</Kwd>: never auto-break; run until max
          </li>
        </ul>
        <p>
          Agents must end with a machine line (last occurrence wins across the
          body; typically the verification agent):
        </p>
        <CodeBlock>{`PIPELINE_OUTCOME: pass
PIPELINE_OUTCOME: fail
PIPELINE_OUTCOME: continue`}</CodeBlock>
        <p>
          Aliases:{" "}
          <InlineCode>PIPELINE_BREAK: pass|fail|done|ok|continue</InlineCode>.
          Rules:
        </p>
        <ul className="list-disc space-y-1.5 pl-4">
          <li>
            Last explicit signal in the body wins (so put{" "}
            <InlineCode>@verification</InlineCode> last).
          </li>
          <li>
            Step error with no signal → synthetic fail (loop continues or breaks
            per break if; does not kill the whole pipeline).
          </li>
          <li>User stop always aborts the pipeline.</li>
          <li>Outside loops, a step error still fails the chain.</li>
        </ul>
      </DocBlock>

      <DocBlock title="Keyword reference">
        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-left text-[11.5px]">
            <thead>
              <tr className="border-b border-border/60 bg-card/50 text-muted-foreground">
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 font-medium">Role</th>
              </tr>
            </thead>
            <tbody className="text-foreground/85">
              <tr className="border-b border-border/40">
                <td className="px-3 py-2 font-mono">@handle</td>
                <td className="px-3 py-2">Invoke a local or ACP agent</td>
              </tr>
              <tr className="border-b border-border/40">
                <td className="px-3 py-2 font-mono">{"->"}</td>
                <td className="px-3 py-2">Chain to the next agent</td>
              </tr>
              <tr className="border-b border-border/40">
                <td className="px-3 py-2 font-mono">loop:</td>
                <td className="px-3 py-2">
                  Start a loop with the default max iterations
                </td>
              </tr>
              <tr className="border-b border-border/40">
                <td className="px-3 py-2 font-mono">loop N:</td>
                <td className="px-3 py-2">
                  Start a loop with max iterations N (e.g.{" "}
                  <span className="font-mono">loop 15:</span>)
                </td>
              </tr>
              <tr className="border-b border-border/40">
                <td className="px-3 py-2 font-mono">break if …</td>
                <td className="px-3 py-2">
                  pass / fail / done / ok / always / never
                </td>
              </tr>
              <tr>
                <td className="px-3 py-2 font-mono">end / endloop</td>
                <td className="px-3 py-2">Optional loop closer</td>
              </tr>
            </tbody>
          </table>
        </div>
      </DocBlock>

      <DocBlock title="Runtime">
        <ol className="list-decimal space-y-1.5 pl-4">
          <li>
            Composer parses a workflow when the message has at least one agent
            mention.
          </li>
          <li>
            Handles resolve against built-in, custom, and ACP agents. Unknown
            handles are rejected before run.
          </li>
          <li>Steps run sequentially with summary handoff.</li>
          <li>
            Each loop iteration runs the body, resolves{" "}
            <InlineCode>PIPELINE_OUTCOME</InlineCode>, then breaks or continues.
            Body step errors become fail outcomes inside the loop; they do not
            abort outer steps.
          </li>
          <li>
            Chat shows structure, live run path, and a break note. Stop aborts
            everything.
          </li>
        </ol>
      </DocBlock>

      <LoopPresetEditorDialog
        preset={editingLoop}
        existing={pipelineLoops.presets}
        absoluteMax={pipelineLoops.absoluteMax}
        onClose={() => setEditingLoop(null)}
        onSave={(preset) => {
          const presets = pipelineLoops.presets.some((p) => p.id === preset.id)
            ? pipelineLoops.presets.map((p) =>
                p.id === preset.id ? preset : p,
              )
            : [...pipelineLoops.presets, preset];
          void setPipelineLoops(
            normalizePipelineLoopSettings({ ...pipelineLoops, presets }),
          );
          setEditingLoop(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loops: usage + default/absolute max + saved presets
// ---------------------------------------------------------------------------

function newLoopPresetId(): string {
  return `loop-${crypto.randomUUID().slice(0, 8)}`;
}

function PipelineLoopsBlock({
  settings,
  onChange,
  onEdit,
}: {
  settings: PipelineLoopSettings;
  onChange: (s: PipelineLoopSettings) => void;
  onEdit: (p: PipelineLoopPreset) => void;
}) {
  const abs = settings.absoluteMax;
  const def = settings.defaultMax;

  const patch = (partial: Partial<PipelineLoopSettings>) => {
    onChange(normalizePipelineLoopSettings({ ...settings, ...partial }));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight text-foreground">
          Loops
        </h2>
        <div className="flex flex-col gap-2.5 text-[12px] leading-relaxed text-muted-foreground">
          <p>
            Wrap a sequence so it repeats until a break condition is met or the
            max is reached. The number after <Kwd>loop</Kwd> is the{" "}
            <strong className="font-medium text-foreground/90">
              max iterations
            </strong>
            .
          </p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>
              Bare <InlineCode>loop:</InlineCode> uses the{" "}
              <strong className="font-medium text-foreground/90">
                default max
              </strong>{" "}
              below.
            </li>
            <li>
              <InlineCode>loop 15:</InlineCode> sets max iterations to 15 (the
              number is highlighted in the composer).
            </li>
            <li>
              Any N is clamped to the{" "}
              <strong className="font-medium text-foreground/90">
                absolute max
              </strong>{" "}
              below (product hard cap {SYSTEM_LOOP_MAX}).
            </li>
          </ul>
          <CodeBlock>{`@architect plan the fix
loop 3:
  @coder implement
  @verification run checks
  break if pass
@reviewer final pass`}</CodeBlock>
          <p>Variants:</p>
          <CodeBlock>{`loop:
  @coder @verification
  break if pass

loop 5:
  @coder
  @reviewer
  break if fail`}</CodeBlock>
          <p>
            Optional closers: <Kwd>end</Kwd> / <Kwd>endloop</Kwd>. Nested loops
            are allowed; keep programs small (at most 24 structural nodes).
            Saved loops insert with <InlineCode>#handle</InlineCode>.
          </p>
        </div>
      </div>

      <SettingRow
        title="Default max"
        description={`Used when you write bare loop: without a number. Currently ${def}.`}
      >
        <Input
          type="number"
          min={1}
          max={abs}
          value={def}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            patch({ defaultMax: clampLoopMax(n, abs) });
          }}
          className="h-8 w-16 text-center text-[12px]"
        />
      </SettingRow>

      <SettingRow
        title="Absolute max"
        description={`Hard ceiling for any loop N (loop 99: clamps to this). Product cap is ${SYSTEM_LOOP_MAX}.`}
      >
        <Input
          type="number"
          min={1}
          max={SYSTEM_LOOP_MAX}
          value={abs}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            const nextAbs = clampLoopMax(n, SYSTEM_LOOP_MAX);
            patch({
              absoluteMax: nextAbs,
              defaultMax: clampLoopMax(def, nextAbs),
            });
          }}
          className="h-8 w-16 text-center text-[12px]"
        />
      </SettingRow>

      <div className="flex items-center justify-between pt-1">
        <div className="flex flex-col">
          <Label>Saved loops</Label>
          <span className="text-[10.5px] text-muted-foreground">
            Insert in the composer with{" "}
            <code className="rounded bg-muted/50 px-1 font-mono">#handle</code>.
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[11px]"
          onClick={() =>
            onEdit({
              id: newLoopPresetId(),
              handle: "",
              name: "",
              description: "",
              max: def || DEFAULT_LOOP_MAX,
              body: "@coder\n@verification\nbreak if pass",
            })
          }
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
          New loop
        </Button>
      </div>

      {settings.presets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/60 bg-card/30 px-4 py-5 text-center text-[11px] text-muted-foreground">
          No saved loops yet. Create one to insert with{" "}
          <code className="font-mono">#handle</code> (expands to full{" "}
          <code className="font-mono">loop N:</code> DSL).
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {settings.presets.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2"
            >
              <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                #{p.handle}
              </code>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium">
                  {p.name}
                  <span className="ml-1.5 font-mono text-[10px] font-normal text-muted-foreground">
                    loop {p.max}
                  </span>
                </span>
                {p.description ? (
                  <span className="truncate text-[10.5px] text-muted-foreground">
                    {p.description}
                  </span>
                ) : (
                  <span className="truncate font-mono text-[10px] text-muted-foreground/80">
                    {p.body.split("\n").filter(Boolean).join(" · ")}
                  </span>
                )}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                onClick={() => onEdit(p)}
                title="Edit"
              >
                <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  patch({
                    presets: settings.presets.filter((x) => x.id !== p.id),
                  })
                }
                title="Delete"
              >
                <HugeiconsIcon
                  icon={Delete02Icon}
                  size={12}
                  strokeWidth={1.75}
                />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LoopPresetEditorDialog({
  preset,
  existing,
  absoluteMax,
  onClose,
  onSave,
}: {
  preset: PipelineLoopPreset | null;
  existing: PipelineLoopPreset[];
  absoluteMax: number;
  onClose: () => void;
  onSave: (p: PipelineLoopPreset) => void;
}) {
  const [draft, setDraft] = useState<PipelineLoopPreset | null>(preset);
  useEffect(() => setDraft(preset), [preset]);
  if (!draft) return null;

  const handleNorm = normalizeHandle(draft.handle);
  const handleOk = isValidHandle(handleNorm);
  const nameOk = draft.name.trim().length > 0;
  const bodyOk = draft.body.trim().length > 0;
  const clash = existing.some(
    (p) => p.id !== draft.id && p.handle === handleNorm,
  );
  const canSave = handleOk && nameOk && bodyOk && !clash;
  const preview = formatLoopPreset(
    {
      ...draft,
      handle: handleNorm,
      max: clampLoopMax(draft.max, absoluteMax),
    },
    absoluteMax,
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md gap-4">
        <DialogHeader>
          <DialogTitle>
            {existing.some((p) => p.id === draft.id) ? "Edit loop" : "New loop"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">Name</span>
              <Input
                value={draft.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setDraft({
                    ...draft,
                    name,
                    handle:
                      draft.handle || normalizeHandle(name) || draft.handle,
                  });
                }}
                placeholder="Implement & verify"
                className="h-8 text-[12px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">
                Handle (#)
              </span>
              <Input
                value={draft.handle}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    handle: e.target.value.toLowerCase().replace(/\s+/g, "-"),
                  })
                }
                placeholder="implement-verify"
                className="h-8 font-mono text-[12px]"
              />
            </div>
          </div>
          {clash ? (
            <p className="text-[11px] text-destructive">
              Handle already used by another saved loop.
            </p>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              Description
            </span>
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
              placeholder="Optional short note"
              className="h-8 text-[12px]"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">
                Max iterations
              </span>
              <span className="text-[10px] text-muted-foreground/80">
                Written as loop N: (capped at {absoluteMax})
              </span>
            </div>
            <Input
              type="number"
              min={1}
              max={absoluteMax || ABSOLUTE_LOOP_MAX}
              value={draft.max}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                setDraft({
                  ...draft,
                  max: clampLoopMax(n, absoluteMax || ABSOLUTE_LOOP_MAX),
                });
              }}
              className="h-8 w-16 text-center text-[12px]"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              Body (agents + optional break)
            </span>
            <Textarea
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              rows={5}
              className="resize-y font-mono text-[11.5px] leading-relaxed"
              placeholder={"@coder implement\n@verification\nbreak if pass"}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              Expands to
            </span>
            <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-foreground/85">
              {preview}
            </pre>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSave}
            onClick={() =>
              onSave({
                ...draft,
                handle: handleNorm,
                name: draft.name.trim(),
                description: draft.description.trim(),
                max: clampLoopMax(draft.max, absoluteMax),
                body: draft.body.trim(),
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
