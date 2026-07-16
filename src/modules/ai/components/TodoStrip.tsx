import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useEffect } from "react";
import { countCompleted, hasActiveTodos, type Todo } from "../lib/todos";
import { useTodosStore } from "../store/todoStore";
import { TodoListRows } from "./TodoList";

type Props = { sessionId: string | null };

const EMPTY_TODOS: Todo[] = [];

/**
 * Live sticky checklist above the composer while work remains.
 * Hides when the list is empty or every item is completed — the finished
 * plan is rendered in-thread by {@link TodoWriteCard}.
 */
export function TodoStrip({ sessionId }: Props) {
  const hydrate = useTodosStore((s) => s.hydrate);
  const todos =
    useTodosStore((s) => (sessionId ? s.bySession[sessionId] : undefined)) ??
    EMPTY_TODOS;

  useEffect(() => {
    if (sessionId) void hydrate(sessionId);
  }, [sessionId, hydrate]);

  // Detach when idle: no items, or every item completed.
  if (!sessionId || todos.length === 0 || !hasActiveTodos(todos)) return null;

  const completed = countCompleted(todos);
  const pct = Math.round((completed / todos.length) * 100);

  return (
    <div className="flex flex-col min-h-0 shrink-0 border-t-2 border-border/40 bg-muted/80 px-3 py-1.5 max-h-[35%] shadow-[0_-4px_12px_-8px_rgba(0,0,0,0.2)]">
      <div className="my-1.5 flex items-center gap-2 shrink-0">
        <span className="text-[11px] font-medium text-foreground">Todos</span>
        <Progress value={pct} className="h-1 flex-1" />
        <span className="text-[11px] tabular-nums font-mono text-muted-foreground">
          {completed}/{todos.length}
        </span>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <TodoListRows todos={todos} />
      </ScrollArea>
    </div>
  );
}
