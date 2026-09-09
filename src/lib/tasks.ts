import type { Prisma, Section, TaskPriority } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import type { CompanyScope } from "@/lib/company-scope";

/**
 * Tasks (SPEC §14).
 *
 * A note to yourself or a colleague — "call Robelyn about the rate", "get the
 * signed copy" — optionally hung on the document it is about. Nothing here
 * posts, and a task has no bearing on the ledger; it is a to-do list that knows
 * what it is next to.
 *
 * **Who may see one is derived, never stored.** A task on an invoice is visible
 * to whoever holds SALES, one on a work order to whoever holds CONSULTANTS, and
 * so on. Storing a `section` column would be a copy of the document's own
 * access rule, free to drift out of step with it; deriving it means a task can
 * never be more visible than the document it is about. A task with no document
 * has no document to leak, and is visible to everyone in the company.
 *
 * Bill payments are the one document with two owners: the same screen serves
 * consultants and vendors, so a task on one is visible to whoever holds either.
 */

/** Which sections may see a task hung on each kind of document. */
const DOCUMENT_SECTIONS = {
  invoiceId: ["SALES"],
  salesOrderId: ["SALES"],
  paymentId: ["SALES"],
  workOrderId: ["CONSULTANTS"],
  expenseId: ["VENDORS"],
  // A consultant's work order and a supplier's bill are settled on one screen
  // by whoever holds either section (SPEC §6).
  billPaymentId: ["CONSULTANTS", "VENDORS"],
} satisfies Record<string, Section[]>;

export type DocumentLink = keyof typeof DOCUMENT_SECTIONS;

export const DOCUMENT_LINKS = Object.keys(DOCUMENT_SECTIONS) as DocumentLink[];

/** What each link is called on screen. */
export const DOCUMENT_LABELS: Record<DocumentLink, string> = {
  invoiceId: "Invoice",
  salesOrderId: "Sales order",
  paymentId: "Customer payment",
  workOrderId: "Work order",
  expenseId: "Expense or bill",
  billPaymentId: "Bill payment",
};

/**
 * The `where` that hides tasks about documents this person cannot open.
 *
 * Built as a positive list of what they may see rather than a list of what to
 * hide: a document type added later is invisible until it is named here, which
 * is the safe direction to fail.
 */
export function visibleTaskWhere(scope: CompanyScope): Prisma.TaskWhereInput {
  const readable = DOCUMENT_LINKS.filter((link) =>
    DOCUMENT_SECTIONS[link].some((section) => scope.hasSection(section)),
  );

  return {
    companyId: scope.companyId,
    OR: [
      // A task with no document behind it has nothing to keep from anyone.
      { AND: DOCUMENT_LINKS.map((link) => ({ [link]: null })) },
      ...readable.map((link) => ({ [link]: { not: null } })),
    ],
  };
}

export type NewTaskInput = {
  subject: string;
  note?: string | null;
  dueDate?: Date | null;
  priority?: TaskPriority;
  assignedUserId?: string | null;
  /** The document this is about, or nothing. At most one key. */
  link?: Partial<Record<DocumentLink, string>>;
};

/** Why these details cannot be saved, or null. Shared by the form and the service. */
export function whyNotATask(input: { subject: string; link?: NewTaskInput["link"] }): string | null {
  const subject = input.subject.trim();
  if (!subject) return "Give the task a subject";
  if (subject.length > 200) return "That subject is too long";

  const links = Object.values(input.link ?? {}).filter(Boolean);
  if (links.length > 1) return "A task belongs to one document, or none";
  return null;
}

/** The link a form submitted, proven to name a document in this company. */
async function resolveLink(companyId: string, link: NewTaskInput["link"]) {
  const entries = Object.entries(link ?? {}).filter(([, id]) => Boolean(id)) as [
    DocumentLink,
    string,
  ][];
  if (entries.length === 0) return {};

  const [field, id] = entries[0];
  // Looked up inside the company, so a guessed id from another company's books
  // cannot be attached to a task here and read back through it.
  const exists = await documentExists(companyId, field, id);
  if (!exists) throw new PostingError("That document is not in this company");
  return { [field]: id };
}

async function documentExists(companyId: string, field: DocumentLink, id: string) {
  const where = { id, companyId };
  switch (field) {
    case "invoiceId":
      return prisma.invoice.findFirst({ where, select: { id: true } });
    case "salesOrderId":
      return prisma.salesOrder.findFirst({ where, select: { id: true } });
    case "workOrderId":
      return prisma.workOrder.findFirst({ where, select: { id: true } });
    case "expenseId":
      return prisma.expense.findFirst({ where, select: { id: true } });
    case "billPaymentId":
      return prisma.billPayment.findFirst({ where, select: { id: true } });
    case "paymentId":
      return prisma.payment.findFirst({ where, select: { id: true } });
  }
}

export async function createTask(scope: CompanyScope, input: NewTaskInput) {
  const refusal = whyNotATask(input);
  if (refusal) throw new PostingError(refusal);

  const link = await resolveLink(scope.companyId, input.link);

  // A task may only be raised against a document the raiser can open — the
  // same rule as reading one, applied at the other end.
  for (const field of Object.keys(link) as DocumentLink[]) {
    if (!DOCUMENT_SECTIONS[field].some((section) => scope.hasSection(section))) {
      throw new PostingError("You cannot raise a task on that document");
    }
  }

  const assignee = input.assignedUserId
    ? await prisma.membership.findFirst({
        where: { userId: input.assignedUserId, companyId: scope.companyId },
        select: { userId: true },
      })
    : null;
  if (input.assignedUserId && !assignee) {
    throw new PostingError("That person is not a member of this company");
  }

  const task = await prisma.task.create({
    data: {
      companyId: scope.companyId,
      subject: input.subject.trim(),
      note: input.note?.trim() || null,
      dueDate: input.dueDate ?? null,
      priority: input.priority ?? "NORMAL",
      assignedUserId: assignee?.userId ?? null,
      createdByUserId: scope.userId,
      ...link,
    },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "task.created",
    entityType: "Task",
    entityId: task.id,
    summary: task.subject,
    data: { priority: task.priority, dueDate: task.dueDate, assignedUserId: task.assignedUserId },
  });

  return task;
}

/** Finish a task, or put it back. Both directions, because both happen. */
export async function setTaskStatus(
  scope: CompanyScope,
  taskId: string,
  status: "OPEN" | "COMPLETED",
) {
  // Read through the visibility filter: a task you cannot see is a task you
  // cannot tick, and it must read as absent rather than as forbidden.
  const task = await prisma.task.findFirst({ where: { id: taskId, ...visibleTaskWhere(scope) } });
  if (!task) throw new PostingError("Task not found in this company");
  if (task.status === status) return task;

  const updated = await prisma.task.update({
    where: { id: task.id },
    data:
      status === "COMPLETED"
        ? { status, completedAt: new Date(), completedByUserId: scope.userId }
        : { status, completedAt: null, completedByUserId: null },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: status === "COMPLETED" ? "task.completed" : "task.reopened",
    entityType: "Task",
    entityId: task.id,
    summary: task.subject,
  });

  return updated;
}

export type TaskFilter = {
  status?: "OPEN" | "COMPLETED" | "ALL";
  assignedUserId?: string | null;
  priority?: TaskPriority | null;
};

export async function listTasks(scope: CompanyScope, filter: TaskFilter = {}) {
  return prisma.task.findMany({
    where: {
      ...visibleTaskWhere(scope),
      ...(filter.status && filter.status !== "ALL" ? { status: filter.status } : {}),
      ...(filter.assignedUserId ? { assignedUserId: filter.assignedUserId } : {}),
      ...(filter.priority ? { priority: filter.priority } : {}),
    },
    include: {
      assignedTo: { select: { id: true, name: true, email: true } },
      createdBy: { select: { id: true, name: true, email: true } },
      invoice: { select: { id: true, invoiceNumber: true } },
      salesOrder: { select: { id: true, orderNumber: true } },
      workOrder: { select: { id: true, workOrderNumber: true } },
      expense: { select: { id: true, description: true, kind: true } },
      billPayment: { select: { id: true, date: true } },
      payment: { select: { id: true, date: true } },
    },
    // Open first, then by due date with the undated last, then newest.
    orderBy: [{ status: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 500,
  });
}

/** The tasks shown on a document's own page. */
export async function tasksForDocument(scope: CompanyScope, link: Partial<Record<DocumentLink, string>>) {
  const entries = Object.entries(link).filter(([, id]) => Boolean(id));
  if (entries.length === 0) return [];

  return prisma.task.findMany({
    where: { ...visibleTaskWhere(scope), ...Object.fromEntries(entries) },
    include: { assignedTo: { select: { id: true, name: true, email: true } } },
    orderBy: [{ status: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
  });
}

/** Everyone who can be given a task: members of this company, bar the clock-only. */
export async function assignableUsers(companyId: string) {
  const memberships = await prisma.membership.findMany({
    where: { companyId, role: { not: "CONSULTANT" } },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return memberships.map((membership) => membership.user);
}
