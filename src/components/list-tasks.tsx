import Link from "next/link";
import { prisma } from "@/lib/db";
import { isoDate, today } from "@/lib/dates";
import { assignableUsers, visibleTaskWhere, type DocumentLink } from "@/lib/tasks";
import { addTask } from "@/app/(app)/tasks/actions";
import { TaskDialog } from "@/components/task-dialog";
import type { CompanyScope } from "@/lib/company-scope";

/**
 * Tasks on a list screen, where there is no detail page to put a panel on.
 *
 * Expenses, bill payments and customer payments are tables, not documents with
 * a page of their own. So each row carries a small "Task" link that names its
 * own id in the query string, and the page renders **one** dialog which opens
 * on arrival. A dialog per row would be two hundred hidden forms to make one of
 * them reachable.
 */

/** How many open tasks each of these documents has, for the row link. */
export async function openTaskCounts(
  scope: CompanyScope,
  field: DocumentLink,
  documentIds: string[],
) {
  if (documentIds.length === 0) return new Map<string, number>();

  const grouped = await prisma.task.groupBy({
    by: [field],
    where: {
      ...visibleTaskWhere(scope),
      status: "OPEN",
      [field]: { in: documentIds },
    },
    _count: { _all: true },
  });

  return new Map(
    grouped
      .map((row) => [(row as Record<string, unknown>)[field] as string, row._count._all] as const)
      .filter(([id]) => Boolean(id)),
  );
}

/** The per-row control. */
export function TaskCell({ href, open }: { href: string; open: number }) {
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center rounded-md px-2 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {open > 0 ? `Tasks (${open})` : "Task"}
    </Link>
  );
}

/** The one dialog the table shares, opened by whichever row named itself. */
export async function ListTaskDialog({
  scope,
  field,
  documentId,
  back,
  title,
}: {
  scope: CompanyScope;
  field: DocumentLink;
  documentId: string;
  back: string;
  title: string;
}) {
  const users = await assignableUsers(scope.companyId);
  return (
    <TaskDialog
      action={addTask}
      users={users}
      back={back}
      link={{ [field]: documentId }}
      defaultAssigneeId={scope.userId}
      today={isoDate(today())}
      title={title}
      autoOpen
      hideTrigger
    />
  );
}
