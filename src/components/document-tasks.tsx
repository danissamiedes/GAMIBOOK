import { formatAccountingDate, isoDate, today } from "@/lib/dates";
import { assignableUsers, tasksForDocument, type DocumentLink } from "@/lib/tasks";
import { addTask, toggleTask } from "@/app/(app)/tasks/actions";
import { TaskDialog } from "@/components/task-dialog";
import type { CompanyScope } from "@/lib/company-scope";

/**
 * The tasks on one document, and the button that adds another.
 *
 * A server component so every document page gets the list, the dialog and the
 * tick boxes by rendering one tag — six pages agreeing by construction rather
 * than by six people remembering the same markup.
 */
export async function DocumentTasks({
  scope,
  link,
  back,
  title,
}: {
  scope: CompanyScope;
  /** One { field: id } pair naming the document. */
  link: Partial<Record<DocumentLink, string>>;
  /** Where the dialog returns to — this page. */
  back: string;
  /** What the pop-out calls itself, e.g. "Task on WO1013". */
  title?: string;
}) {
  const [tasks, users] = await Promise.all([
    tasksForDocument(scope, link),
    assignableUsers(scope.companyId),
  ]);

  const open = tasks.filter((task) => task.status === "OPEN");

  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Tasks{open.length > 0 ? ` — ${open.length} open` : ""}
        </h2>
        <TaskDialog
          action={addTask}
          users={users}
          back={back}
          link={link as Record<string, string>}
          defaultAssigneeId={scope.userId}
          today={isoDate(today())}
          title={title}
        />
      </div>

      {tasks.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nothing to do here yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2 text-sm">
              <form action={toggleTask} className="pt-0.5">
                <input type="hidden" name="taskId" value={task.id} />
                <input type="hidden" name="back" value={back} />
                <input
                  type="hidden"
                  name="next"
                  value={task.status === "OPEN" ? "COMPLETED" : "OPEN"}
                />
                <button
                  type="submit"
                  aria-label={
                    task.status === "OPEN"
                      ? `Mark "${task.subject}" done`
                      : `Reopen "${task.subject}"`
                  }
                  className="flex h-4 w-4 items-center justify-center rounded border border-slate-300 text-[10px] leading-none dark:border-slate-600 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
                >
                  {task.status === "COMPLETED" ? "✓" : ""}
                </button>
              </form>
              <div className="min-w-0 flex-1">
                <div
                  className={
                    task.status === "COMPLETED" ? "text-slate-400 line-through" : "font-medium"
                  }
                >
                  {task.subject}
                </div>
                {task.note ? (
                  <p className="whitespace-pre-wrap text-xs text-slate-500">{task.note}</p>
                ) : null}
                <p className="text-xs text-slate-500">
                  {task.priority !== "NORMAL" ? `${task.priority.toLowerCase()} priority · ` : ""}
                  {task.dueDate ? `due ${formatAccountingDate(task.dueDate)}` : "no due date"}
                  {task.assignedTo ? ` · ${task.assignedTo.name ?? task.assignedTo.email}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
