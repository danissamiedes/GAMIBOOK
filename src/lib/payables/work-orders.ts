import type { PayableStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import {
  accountingDate,
  allocateNumber,
  postJournalEntry,
  reverseJournalEntry,
} from "@/lib/ledger/post";
import { amendPosting } from "@/lib/ledger/amend";
import {
  ERASE_ENTRY_INCLUDE,
  eraseEntry,
  snapshotEntry,
  whyNotErasable,
} from "@/lib/ledger/erase";
import { isBaseCurrency, toBase } from "@/lib/ledger/fx";

/**
 * Work orders (SPEC §8.1) and their posting rule (SPEC §4.3):
 *
 *   DR  Line account(s)      per line, at the line amount
 *       CR  Accounts Payable     work order net total
 *
 * Two things make this different from an invoice. Each line names its own
 * account, so one document can hit Consultant Fees and Supplies Expense. And a
 * line may be **negative** — a cash advance being recovered — which posts as a
 * credit to that line's own account, never as a negative debit.
 *
 * Approval is what posts, dated `approvedAt`, which defaults to the work
 * order's own issue date rather than the day the button was clicked.
 */

export async function recalculateWorkOrder(workOrderId: string, tx: Prisma.TransactionClient) {
  const workOrder = await tx.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: {
      lines: true,
      applications: { include: { billPayment: { select: { reversedAt: true } } } },
    },
  });

  const total = sum(workOrder.lines.map((line) => money(line.amount)));
  const amountPaid = sum(
    workOrder.applications
      .filter((application) => !application.billPayment.reversedAt)
      .map((application) => money(application.amountApplied)),
  );
  const balanceDue = total.minus(amountPaid);

  let status = workOrder.status;
  if (workOrder.status !== "DRAFT" && workOrder.status !== "VOID") {
    if (total.greaterThan(0) && balanceDue.lessThanOrEqualTo(0)) status = "PAID";
    else if (amountPaid.greaterThan(0)) status = "PARTIALLY_PAID";
    else status = "APPROVED";
  }

  return tx.workOrder.update({
    where: { id: workOrderId },
    data: { total, amountPaid, balanceDue, status },
  });
}

/**
 * The journal lines a work order posts: DR each line's account (CR when the
 * line is a negative deduction), CR A/P for the converted total, residual to
 * FX Rounding Difference (SPEC §4.3).
 *
 * Shared by approval and by editing an approved work order, so a corrected
 * document and the one it replaces are built by the same arithmetic.
 */
async function workOrderPostingLines(
  tx: Prisma.TransactionClient,
  companyId: string,
  workOrderId: string,
  label: string,
) {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { baseCurrency: true },
  });

  await recalculateWorkOrder(workOrderId, tx);
  const fresh = await tx.workOrder.findUniqueOrThrow({
    where: { id: workOrderId },
    include: { lines: { orderBy: { lineNumber: "asc" } } },
  });

  const total = money(fresh.total);
  if (total.lessThanOrEqualTo(0)) {
    // Deductions exceeding the work are not a payable — that is money the
    // consultant owes back, which is a receivable (SPEC §8.3).
    throw new PostingError(
      "A work order must net to more than zero. Deductions exceeding the work are not a payable.",
    );
  }

  const foreign = !isBaseCurrency(fresh.currency, company.baseCurrency);
  const fxRate = foreign ? money(fresh.fxRate) : money(1);
  if (foreign && fxRate.lessThanOrEqualTo(0)) {
    throw new PostingError("A foreign-currency work order needs an exchange rate");
  }

  // Convert the total as the authoritative figure and the lines individually,
  // then post whatever is left over to FX Rounding Difference (SPEC §4.3).
  const baseTotal = toBase(total, fxRate);
  const baseLines = fresh.lines.map((line) => ({
    line,
    baseAmount: toBase(money(line.amount), fxRate),
  }));
  const summed = sum(baseLines.map((entry) => entry.baseAmount));
  const residual = baseTotal.minus(summed);

  const payable = await systemAccount(companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx);

  const lines: Parameters<typeof postJournalEntry>[0]["lines"] = baseLines.map((entry) => ({
    accountId: entry.line.accountId,
    // A negative line credits its own account rather than debiting a
    // negative amount — that is what keeps the entry legal and readable.
    debit: entry.baseAmount.isNegative() ? undefined : entry.baseAmount,
    credit: entry.baseAmount.isNegative() ? entry.baseAmount.abs() : undefined,
    description: entry.line.description,
    vendorId: fresh.vendorId,
    ...(foreign
      ? { currency: fresh.currency, fxRate, foreignAmount: money(entry.line.amount) }
      : {}),
  }));

  lines.push({
    accountId: payable.id,
    credit: baseTotal,
    description: `Work order ${label}`,
    vendorId: fresh.vendorId,
    ...(foreign ? { currency: fresh.currency, fxRate, foreignAmount: total } : {}),
  });

  if (!residual.isZero()) {
    const rounding = await systemAccount(companyId, SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE, tx);
    // A/P is credited with the authoritative total, so a positive residual
    // leaves the entry short of debits by exactly that much.
    lines.push({
      accountId: rounding.id,
      debit: residual.isPositive() ? residual : undefined,
      credit: residual.isNegative() ? residual.abs() : undefined,
      description: "FX rounding difference",
    });
  }

  return { lines, baseTotal, fresh };
}

export async function approveWorkOrder(input: {
  companyId: string;
  workOrderId: string;
  /** Defaults to the work order's own issueDate (SPEC §8.1). */
  approvedAt?: Date | null;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: input.workOrderId, companyId: input.companyId },
      include: { lines: { orderBy: { lineNumber: "asc" } }, vendor: true },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");
    if (workOrder.status !== "DRAFT") throw new PostingError("Only a draft work order can be approved");
    if (workOrder.lines.length === 0) throw new PostingError("A work order needs at least one line");

    const { formatted } = await allocateNumber(tx, input.companyId, "WORK_ORDER");
    const { lines, baseTotal, fresh } = await workOrderPostingLines(
      tx,
      input.companyId,
      workOrder.id,
      formatted,
    );

    const approvedAt = accountingDate(input.approvedAt ?? fresh.issueDate);

    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: approvedAt,
        memo: `Work order ${formatted}`,
        sourceType: "WORK_ORDER",
        sourceId: fresh.id,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    const updated = await tx.workOrder.update({
      where: { id: fresh.id },
      data: {
        workOrderNumber: formatted,
        status: "APPROVED",
        approvedAt,
        approvedByUserId: input.userId ?? null,
        baseTotal,
      },
      include: { lines: true },
    });

    return { workOrder: updated, entry };
  });
}

export async function voidWorkOrder(input: {
  companyId: string;
  workOrderId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: input.workOrderId, companyId: input.companyId },
      include: { applications: { include: { billPayment: true } } },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");
    if (workOrder.status === "VOID") throw new PostingError("This work order is already void");
    if (workOrder.status === "DRAFT") throw new PostingError("A draft is deleted, not voided");

    const live = workOrder.applications.filter((a) => !a.billPayment.reversedAt);
    if (live.length > 0) {
      throw new PostingError(
        "This work order has payments applied. Reverse them first, so the cash is accounted for.",
      );
    }

    const original = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "WORK_ORDER", sourceId: workOrder.id },
      orderBy: { postedAt: "asc" },
    });
    if (original && !original.reversedByEntryId) {
      await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: original.id,
          date: input.date,
          memo: `Void of work order ${workOrder.workOrderNumber}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
    }

    return tx.workOrder.update({
      where: { id: workOrder.id },
      data: { status: "VOID", voidedAt: new Date(), balanceDue: 0, baseRelieved: 0 },
    });
  });
}

export async function deleteDraftWorkOrder(companyId: string, workOrderId: string) {
  const workOrder = await prisma.workOrder.findFirst({ where: { id: workOrderId, companyId } });
  if (!workOrder) throw new PostingError("Work order not found in this company");
  if (workOrder.status !== "DRAFT") {
    throw new PostingError("Only a draft can be deleted. Approved work orders are voided.");
  }
  await prisma.workOrder.delete({ where: { id: workOrderId } });
}

/** Line amount, computed rather than trusted. Negative rates are legitimate. */
export function computeWorkOrderLine(line: {
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
}) {
  return toCents(money(line.quantity).times(money(line.rate)));
}

export type WorkOrderLineInput = {
  description: string;
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
  accountId: string;
};

/**
 * Edit a work order (SPEC §8.1, which mirrors the invoice machine in §7.1).
 *
 *   DRAFT     — changed freely, nothing posted.
 *   APPROVED  — reversed and reposted (SPEC §4.2 rule 3), keeping its number.
 *
 * Blocked once payments are applied: the consultant has been paid against this
 * document, and moving what it says without moving the payment leaves the two
 * disagreeing.
 */
export async function updateWorkOrder(input: {
  companyId: string;
  workOrderId: string;
  vendorId?: string;
  issueDate?: Date;
  dueDate?: Date;
  currency?: string;
  fxRate?: Prisma.Decimal.Value;
  memo?: string | null;
  lines: WorkOrderLineInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: input.workOrderId, companyId: input.companyId },
      include: { applications: { include: { billPayment: { select: { reversedAt: true } } } } },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");
    if (workOrder.status === "VOID") {
      throw new PostingError("A void work order cannot be edited. Raise a new one instead.");
    }
    if (input.lines.length === 0) throw new PostingError("A work order needs at least one line");

    const live = workOrder.applications.filter((a) => !a.billPayment.reversedAt);
    if (live.length > 0) {
      throw new PostingError(
        "This work order has payments applied. Reverse them first, then edit it.",
      );
    }

    if (input.vendorId && input.vendorId !== workOrder.vendorId) {
      const vendor = await tx.vendor.findFirst({
        where: { id: input.vendorId, companyId: input.companyId },
      });
      if (!vendor) throw new PostingError("Vendor not found in this company");
    }

    await tx.workOrderLine.deleteMany({ where: { workOrderId: workOrder.id } });
    await tx.workOrder.update({
      where: { id: workOrder.id },
      data: {
        vendorId: input.vendorId ?? workOrder.vendorId,
        issueDate: input.issueDate ? accountingDate(input.issueDate) : workOrder.issueDate,
        dueDate: input.dueDate ? accountingDate(input.dueDate) : workOrder.dueDate,
        currency: input.currency ? input.currency.toUpperCase() : workOrder.currency,
        fxRate: input.fxRate ?? workOrder.fxRate,
        memo: input.memo === undefined ? workOrder.memo : input.memo,
        lines: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: computeWorkOrderLine(line),
            accountId: line.accountId,
          })),
        },
      },
    });

    if (workOrder.status === "DRAFT") {
      await recalculateWorkOrder(workOrder.id, tx);
      return tx.workOrder.findUniqueOrThrow({
        where: { id: workOrder.id },
        include: { lines: { orderBy: { lineNumber: "asc" } } },
      });
    }

    const { lines, baseTotal, fresh } = await workOrderPostingLines(
      tx,
      input.companyId,
      workOrder.id,
      workOrder.workOrderNumber ?? "draft",
    );

    await amendPosting(
      {
        companyId: input.companyId,
        sourceType: "WORK_ORDER",
        sourceId: workOrder.id,
        date: accountingDate(workOrder.approvedAt ?? fresh.issueDate),
        memo: `Work order ${workOrder.workOrderNumber ?? ""}`.trim(),
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    return tx.workOrder.update({
      where: { id: workOrder.id },
      data: { baseTotal },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
  });
}

/**
 * Why an approved work order cannot be deleted, or null if it can. Exported so
 * the list decides with the same rule the delete enforces.
 */
export type WorkOrderDeletableInput = {
  workOrder: {
    status: PayableStatus;
    voidedAt: Date | null;
    createdAt: Date;
    lastEmailedAt: Date | null;
    applications: { billPayment: { reversedAt: Date | null } }[];
  };
  entry: {
    postedAt: Date;
    date: Date;
    createdByUserId: string | null;
    reversedByEntryId: string | null;
  } | null;
  postings: number;
  bankMatchCount: number;
  booksClosedThrough: Date | null;
  userId: string;
};

export function whyNotDeletableWorkOrder(input: WorkOrderDeletableInput): string | null {
  const { workOrder } = input;
  if (workOrder.status === "DRAFT") return "A draft work order is deleted, not erased.";

  const live = workOrder.applications.filter((a) => !a.billPayment.reversedAt);
  return whyNotErasable({
    noun: "work order",
    document: workOrder,
    entry: input.entry,
    postings: input.postings,
    bankMatchCount: input.bankMatchCount,
    booksClosedThrough: input.booksClosedThrough,
    userId: input.userId,
    dependency:
      live.length > 0
        ? "This work order has payments applied. Reverse them first, or void the work order instead of deleting it."
        : workOrder.lastEmailedAt
          ? "This work order has been emailed to the consultant, so they are holding a document with this number on it. Void it instead — that leaves a record you can explain."
          : null,
  });
}

/**
 * Erase an approved work order recorded by mistake — the order, its lines and
 * its journal entry. Narrow on purpose; see `erase.ts`. A draft goes through
 * `deleteDraftWorkOrder` instead.
 */
export async function deleteWorkOrder(input: {
  companyId: string;
  workOrderId: string;
  userId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: input.workOrderId, companyId: input.companyId },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
        vendor: { select: { name: true } },
      },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");

    const entry = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "WORK_ORDER", sourceId: workOrder.id },
      orderBy: { postedAt: "asc" },
      include: ERASE_ENTRY_INCLUDE,
    });

    const [postings, bankMatchCount, company] = await Promise.all([
      tx.journalEntry.count({
        where: { companyId: input.companyId, sourceType: "WORK_ORDER", sourceId: workOrder.id },
      }),
      tx.bankTransaction.count({
        where: {
          companyId: input.companyId,
          OR: [
            { workOrderId: workOrder.id },
            ...(entry ? [{ matchedJournalEntryId: entry.id }] : []),
          ],
        },
      }),
      tx.company.findUniqueOrThrow({
        where: { id: input.companyId },
        select: { booksClosedThrough: true },
      }),
    ]);

    const refusal = whyNotDeletableWorkOrder({
      workOrder,
      entry,
      postings,
      bankMatchCount,
      booksClosedThrough: company.booksClosedThrough,
      userId: input.userId,
    });
    if (refusal) throw new PostingError(refusal);

    const snapshot = {
      workOrder: {
        id: workOrder.id,
        workOrderNumber: workOrder.workOrderNumber,
        vendorId: workOrder.vendorId,
        vendorName: workOrder.vendor.name,
        issueDate: workOrder.issueDate.toISOString().slice(0, 10),
        dueDate: workOrder.dueDate.toISOString().slice(0, 10),
        approvedAt: workOrder.approvedAt ? workOrder.approvedAt.toISOString().slice(0, 10) : null,
        currency: workOrder.currency,
        fxRate: money(workOrder.fxRate).toString(),
        memo: workOrder.memo,
        total: money(workOrder.total).toFixed(2),
        importBatchId: workOrder.importBatchId,
        createdAt: workOrder.createdAt.toISOString(),
        lines: workOrder.lines.map((line) => ({
          lineNumber: line.lineNumber,
          description: line.description,
          quantity: money(line.quantity).toString(),
          rate: money(line.rate).toString(),
          amount: money(line.amount).toFixed(2),
          accountId: line.accountId,
        })),
      },
      entry: snapshotEntry(entry!),
    };

    await eraseEntry(tx, entry!.id, input.companyId);
    // Lines cascade with the work order.
    await tx.workOrder.delete({ where: { id: workOrder.id } });

    await tx.auditLog.create({
      data: {
        companyId: input.companyId,
        userId: input.userId,
        action: "workOrder.deleted",
        entityType: "WorkOrder",
        entityId: workOrder.id,
        summary: `Deleted work order ${workOrder.workOrderNumber ?? workOrder.id} for ${money(
          workOrder.total,
        ).toFixed(2)} ${workOrder.currency} to ${workOrder.vendor.name}, entry ${
          entry!.entryNumber
        }`,
        data: snapshot,
      },
    });

    return snapshot;
  });
}
