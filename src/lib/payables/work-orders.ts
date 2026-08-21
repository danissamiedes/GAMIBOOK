import type { Prisma, Role } from "@prisma/client";
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

    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    await recalculateWorkOrder(workOrder.id, tx);
    const fresh = await tx.workOrder.findUniqueOrThrow({
      where: { id: workOrder.id },
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

    const payable = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx);

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

    const { formatted } = await allocateNumber(tx, input.companyId, "WORK_ORDER");

    lines.push({
      accountId: payable.id,
      credit: baseTotal,
      description: `Work order ${formatted}`,
      vendorId: fresh.vendorId,
      ...(foreign ? { currency: fresh.currency, fxRate, foreignAmount: total } : {}),
    });

    if (!residual.isZero()) {
      const rounding = await systemAccount(
        input.companyId,
        SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE,
        tx,
      );
      // A/P is credited with the authoritative total, so a positive residual
      // leaves the entry short of debits by exactly that much.
      lines.push({
        accountId: rounding.id,
        debit: residual.isPositive() ? residual : undefined,
        credit: residual.isNegative() ? residual.abs() : undefined,
        description: "FX rounding difference",
      });
    }

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
