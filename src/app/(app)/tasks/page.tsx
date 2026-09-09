import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { companyScope } from "@/lib/session-scope";
import { assignableUsers, listTasks } from "@/lib/tasks";
import { addTask, toggleTask } from "./actions";
import { TaskDialog } from "@/components/task-dialog";
import { formatAccountingDate, isoDate, today } from "@/lib/dates";
import { Alert, Card, DataTable, EmptyState, Field, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Tasks") };

type Task = Awaited<ReturnType<typeof listTasks>>[number];

/** The document a task hangs on, as a link — or nothing, for a standalone one. */
function documentOf(task: Task) {
  if (task.invoice) {
    return { label: `Invoice ${task.invoice.invoiceNumber ?? "(draft)"}`, href: `/invoices/${task.invoice.id}` };
  }
  if (task.salesOrder) {
    return { label: `Sales order ${task.salesOrder.orderNumber ?? "(draft)"}`, href: `/sales-orders/${task.salesOrder.id}` };
  }
  if (task.workOrder) {
    return { label: `Work order ${task.workOrder.workOrderNumber ?? "(draft)"}`, href: `/work-orders/${task.workOrder.id}` };
  }
  if (task.expense) {
    return {
      label: `${task.expense.kind === "BILL" ? "Bill" : "Expense"} — ${task.expense.description}`,
      href: `/expenses?tab=${task.expense.kind === "BILL" ? "bill" : "direct"}`,
    };
  }
  if (task.billPayment) {
    return { label: `Bill payment ${formatAccountingDate(task.billPayment.date)}`, href: `/bill-payments/${task.billPayment.id}` };
  }
  if (task.payment) {
    return { label: `Customer payment ${formatAccountingDate(task.payment.date)}`, href: `/payments/${task.payment.id}` };
  }
  return null;
}

/**
 * Every task, across every document (SPEC §14).
 *
 * The list shows only what this person could open anyway: a task on an invoice
 * needs the Sales section to appear here, so the board is not a way around the
 * access rules on the documents themselves.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    assigned?: string;
    priority?: string;
    taskSaved?: string;
    taskError?: string;
  }>;
}) {
  const scope = await companyScope();
  const params = await searchParams;

  const status = params.status === "COMPLETED" || params.status === "ALL" ? params.status : "OPEN";

  const [tasks, users] = await Promise.all([
    listTasks(scope, {
      status,
      assignedUserId: params.assigned || null,
      priority:
        params.priority === "LOW" || params.priority === "NORMAL" || params.priority === "HIGH"
          ? params.priority
          : null,
    }),
    assignableUsers(scope.companyId),
  ]);

  const back = "/tasks";
  const overdue = (task: Task) =>
    task.status === "OPEN" && task.dueDate !== null && task.dueDate < today();

  return (
    <>
      <PageHeader
        title="Tasks"
        description="What still has to be done, and who is doing it. Tasks never touch the ledger."
      />

      {params.taskError ? (
        <Alert tone="error">{decodeURIComponent(params.taskError)}</Alert>
      ) : null}
      {params.taskSaved ? <Alert tone="success">Task saved.</Alert> : null}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <form className="flex flex-wrap items-end gap-3">
            <Field label="Show">
              <Select name="status" defaultValue={status}>
                <option value="OPEN">Open</option>
                <option value="COMPLETED">Completed</option>
                <option value="ALL">All</option>
              </Select>
            </Field>
            <Field label="Assigned to">
              <Select name="assigned" defaultValue={params.assigned ?? ""}>
                <option value="">Anyone</option>
                {users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority">
              <Select name="priority" defaultValue={params.priority ?? ""}>
                <option value="">Any</option>
                <option value="HIGH">High</option>
                <option value="NORMAL">Normal</option>
                <option value="LOW">Low</option>
              </Select>
            </Field>
            <button
              type="submit"
              className="inline-flex h-9 items-center rounded-md border border-slate-300 px-3 text-sm dark:border-slate-600"
            >
              Filter
            </button>
          </form>

          <TaskDialog
            action={addTask}
            users={users}
            back={back}
            defaultAssigneeId={scope.userId}
            today={isoDate(today())}
            label="New task"
            title="New task"
          />
        </div>
      </Card>

      {tasks.length === 0 ? (
        <EmptyState title="Nothing on the list">
          {status === "OPEN"
            ? "No open tasks. Add one here, or from any invoice, bill, work order or payment."
            : "Nothing matches this filter."}
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="w-10 py-2">Done</th>
                <th className="py-2">Task</th>
                <th className="py-2">About</th>
                <th className="py-2">Assigned</th>
                <th className="py-2">Due</th>
                <th className="py-2">Priority</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const document = documentOf(task);
                return (
                  <tr key={task.id} className="border-b border-slate-100 align-top dark:border-slate-800/60">
                    <td className="py-2">
                      <form action={toggleTask}>
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
                          className="flex h-5 w-5 items-center justify-center rounded border border-slate-300 text-xs dark:border-slate-600 [@media(pointer:coarse)]:h-7 [@media(pointer:coarse)]:w-7"
                        >
                          {task.status === "COMPLETED" ? "✓" : ""}
                        </button>
                      </form>
                    </td>
                    <td className="py-2">
                      <div className={task.status === "COMPLETED" ? "text-slate-400 line-through" : "font-medium"}>
                        {task.subject}
                      </div>
                      {task.note ? (
                        <p className="whitespace-pre-wrap text-xs text-slate-500">{task.note}</p>
                      ) : null}
                    </td>
                    <td className="py-2 text-sm">
                      {document ? (
                        <Link className="underline decoration-dotted underline-offset-2" href={document.href}>
                          {document.label}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-sm">
                      {task.assignedTo ? (
                        task.assignedTo.name ?? task.assignedTo.email
                      ) : (
                        <span className="text-slate-400">Nobody</span>
                      )}
                    </td>
                    <td className={`py-2 text-sm ${overdue(task) ? "font-medium text-red-700 dark:text-red-300" : ""}`}>
                      {task.dueDate ? formatAccountingDate(task.dueDate) : "—"}
                      {overdue(task) ? " · overdue" : ""}
                    </td>
                    <td className="py-2 text-sm">
                      {task.priority === "HIGH" ? (
                        <span className="font-medium text-red-700 dark:text-red-300">High</span>
                      ) : task.priority === "LOW" ? (
                        <span className="text-slate-400">Low</span>
                      ) : (
                        "Normal"
                      )}
                    </td>
                    <td className="py-2 text-sm">
                      {task.status === "COMPLETED" ? (
                        <span className="text-slate-500">
                          Completed {task.completedAt ? formatAccountingDate(task.completedAt) : ""}
                        </span>
                      ) : (
                        <span className="font-medium">Open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </Card>
      )}

    </>
  );
}
