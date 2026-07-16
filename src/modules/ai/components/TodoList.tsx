import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  CheckListIcon,
  CheckmarkSquare02Icon,
  SquareIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  countCompleted,
  isTodosComplete,
  parseTodosInput,
  type Todo,
} from "../lib/todos";

export function TodoListRows({ todos }: { todos: Todo[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {todos.map((t) => (
        <TodoRow key={t.id} todo={t} />
      ))}
    </ul>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  const isInProgress = todo.status === "in_progress";
  const row = (
    <li
      className={cn(
        "flex items-start gap-2 rounded px-1.5 py-1 text-[11px] leading-snug",
        isInProgress && "border-l-2 border-foreground/50 bg-muted/40",
      )}
    >
      <span className="mt-[2px] inline-flex size-3.5 shrink-0 items-center justify-center">
        {isInProgress ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon
            icon={
              todo.status === "completed" ? CheckmarkSquare02Icon : SquareIcon
            }
            strokeWidth={1.75}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1",
          todo.status === "completed"
            ? "text-muted-foreground/60 line-through"
            : isInProgress
              ? "text-foreground"
              : "text-muted-foreground",
        )}
      >
        {todo.title}
      </span>
    </li>
  );

  if (!todo.description) return row;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs text-[11px]">
          {todo.description}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Thread rendering for `todo_write`.
 * Active/partial updates stay as a compact chip (live list lives in TodoStrip).
 * When every item is completed, render the full checklist in-thread so the
 * bottom strip can detach without losing the plan from the conversation.
 */
export function TodoWriteCard({
  input,
  state,
}: {
  input: unknown;
  state: string;
}) {
  const todos = parseTodosInput(input);
  const isError = state === "output-error";

  if (!todos) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isError
              ? "bg-destructive"
              : state === "output-available"
                ? "bg-transparent border border-muted-foreground/40"
                : "bg-muted-foreground/40",
          )}
        />
        <HugeiconsIcon
          icon={CheckListIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="font-medium text-foreground">Todos</span>
        <span className="text-[11px] text-muted-foreground">
          {isError ? "failed" : "updating…"}
        </span>
      </div>
    );
  }

  const completed = countCompleted(todos);
  const allDone = isTodosComplete(todos);
  const inProgress = todos.find((t) => t.status === "in_progress");

  if (!allDone) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isError
              ? "bg-destructive"
              : state === "output-available"
                ? "bg-transparent border border-muted-foreground/40"
                : "bg-amber-500",
          )}
        />
        <HugeiconsIcon
          icon={CheckListIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Todos</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          {completed}/{todos.length}
        </span>
        {inProgress ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {inProgress.title}
          </span>
        ) : (
          <span className="flex-1" />
        )}
      </div>
    );
  }

  // Completed plan: full checklist lives in the thread (strip detaches).
  return (
    <div className="my-0.5 rounded-md border border-border/50 bg-muted/40 px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <HugeiconsIcon
          icon={CheckListIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[11px] font-medium text-foreground">Todos</span>
        <Progress value={100} className="h-1 flex-1" />
        <span className="text-[11px] tabular-nums font-mono text-muted-foreground">
          {completed}/{todos.length}
        </span>
        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          done
        </span>
      </div>
      <TodoListRows todos={todos} />
    </div>
  );
}
