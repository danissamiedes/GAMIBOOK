import type { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { isBaseCurrency, relieveProRata, toBase } from "@/lib/ledger/fx";
import { recalculateWorkOrder } from "./work-orders";

/**
 * Payments to consultants and vendors (SPEC §8.1) — the mirror of the receipts
 * side, and the same rule (SPEC §4.3):
 *
 *   DR  Accounts Payable    amount applied, at the DOCUMENT's fx rate
 *       CR  Bank                amount paid, at the PAYMENT's fx rate
 *   DR/CR  Realized FX Gain/Loss
 *
 * A/P comes off at the rate the payable was booked at, or the control account
 * never clears. One A/P line per document, each at its own rate.
 */

export type BillApplicationInput = {
  workOrderId?: string;
  expenseId?: string;
  amountApplied: Prisma.Decimal.Value;
};

type OpenDocument = {
  id: string;
  kind: "workOrder" | "expense";
  currency: string;
  fxRate: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
  baseTotal: Prisma.Decimal;
  baseRelieved: Prisma.Decimal;
  total: Prisma.Decimal;
  label: string;
  status: string;
};

async function loadDocument(
  tx: Prisma.TransactionClient,
  companyId: string,
  application: BillApplicationInput,
): Promise<OpenDocument> {
  if (application.workOrderId && application.expenseId) {
    throw new PostingError("An application points at one document, not two");
  }

  if (application.workOrderId) {
    const workOrder = await tx.workOrder.findFirst({
      where: { id: application.workOrderId, companyId },
    });
    if (!workOrder) throw new PostingError("Work order not found in this company");
    return {
      id: workOrder.id,
      kind: "workOrder",
      currency: workOrder.currency,
      fxRate: workOrder.fxRate,
      balanceDue: workOrder.balanceDue,
      baseTotal: workOrder.baseTotal,
      baseRelieved: workOrder.baseRelieved,
      total: workOrder.total,
      label: `Work order ${workOrder.workOrderNumber ?? "draft"}`,
      status: workOrder.status,
    };
  }

  if (application.expenseId) {
    const expense = await tx.expense.findFirst({
      where: { id: application.expenseId, companyId },
    });
    if (!expense) throw new PostingError("Bill not found in this company");
    if (expense.kind !== "BILL") {
      throw new PostingError("That expense was paid when it was recorded — there is nothing to settle");
    }
    return {
      id: expense.id,
      kind: "expense",
      currency: expense.currency,
      fxRate: expense.fxRate,
      balanceDue: expense.balanceDue,
      baseTotal: expense.baseTotal,
      baseRelieved: expense.baseRelieved,
      total: expense.amount,
      label: expense.description,
      status: expense.status,
    };
  }

  throw new PostingError("An application must name a work order or a bill");
}

export async function recordBillPayment(input: {
  companyId: string;
  vendorId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  paymentAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: BillApplicationInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) throw new PostingError("A payment must be more than zero");

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
    });
    if (!vendor) throw new PostingError("Vendor not found in this company");

    const paymentAccount = await tx.account.findFirst({
      where: { id: input.paymentAccountId, companyId: input.companyId, isActive: true },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found in this company");

    const foreignPayment = !isBaseCurrency(input.currency, company.baseCurrency);
    const paymentRate = foreignPayment ? money(input.fxRate ?? 0) : money(1);
    if (foreignPayment && paymentRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency payment needs an exchange rate");
    }

    const applied = sum(input.applications.map((application) => money(application.amountApplied)));
    if (applied.greaterThan(amount)) {
      throw new PostingError(
        `Applied ${applied.toFixed(2)} exceeds the payment of ${amount.toFixed(2)}`,
      );
    }
    if (applied.lessThan(amount)) {
      throw new PostingError(
        "Apply the whole payment. Paying a vendor more than you owe them is an advance, which is not in scope here.",
      );
    }

    const payment = await tx.billPayment.create({
      data: {
        companyId: input.companyId,
        vendorId: vendor.id,
        date: accountingDate(input.date),
        amount,
        currency: input.currency.toUpperCase(),
        fxRate: paymentRate,
        paymentAccountId: paymentAccount.id,
        method: input.method ?? "BANK_TRANSFER",
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    const payable = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx);
    const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [];
    let baseRelievedTotal = money(0);

    for (const application of input.applications) {
      const applicationAmount = toCents(money(application.amountApplied));
      if (applicationAmount.lessThanOrEqualTo(0)) {
        throw new PostingError("Each application must be more than zero");
      }

      const document = await loadDocument(tx, input.companyId, application);
      if (document.status === "DRAFT") {
        throw new PostingError(`${document.label} is still a draft — approve it before paying it`);
      }
      if (document.status === "VOID") throw new PostingError("A void document cannot be paid");
      if (document.currency !== input.currency.toUpperCase()) {
        throw new PostingError(
          `Payment is in ${input.currency} but ${document.label} is in ${document.currency}`,
        );
      }
      if (applicationAmount.greaterThan(money(document.balanceDue))) {
        throw new PostingError(
          `Applying ${applicationAmount.toFixed(2)} to ${document.label} exceeds its balance of ${money(
            document.balanceDue,
          ).toFixed(2)}`,
        );
      }

      const settles = money(document.balanceDue).minus(applicationAmount).lessThanOrEqualTo(0);
      const baseRelieved = relieveProRata({
        documentBaseTotal: document.baseTotal,
        alreadyRelieved: document.baseRelieved,
        documentForeignTotal: document.total,
        foreignApplied: applicationAmount,
        settlesDocument: settles,
      });
      baseRelievedTotal = baseRelievedTotal.plus(baseRelieved);

      lines.push({
        accountId: payable.id,
        debit: baseRelieved,
        description: document.label,
        vendorId: vendor.id,
        ...(document.currency !== company.baseCurrency
          ? {
              currency: document.currency,
              fxRate: money(document.fxRate),
              foreignAmount: applicationAmount,
            }
          : {}),
      });

      await tx.billPaymentApplication.create({
        data: {
          billPaymentId: payment.id,
          workOrderId: document.kind === "workOrder" ? document.id : null,
          expenseId: document.kind === "expense" ? document.id : null,
          amountApplied: applicationAmount,
        },
      });

      if (document.kind === "workOrder") {
        await tx.workOrder.update({
          where: { id: document.id },
          data: { baseRelieved: money(document.baseRelieved).plus(baseRelieved) },
        });
        await recalculateWorkOrder(document.id, tx);
      } else {
        const paidNow = money(document.total).minus(money(document.balanceDue)).plus(applicationAmount);
        const balance = money(document.total).minus(paidNow);
        await tx.expense.update({
          where: { id: document.id },
          data: {
            baseRelieved: money(document.baseRelieved).plus(baseRelieved),
            amountPaid: paidNow,
            balanceDue: balance,
            status: balance.lessThanOrEqualTo(0) ? "PAID" : "PARTIALLY_PAID",
          },
        });
      }
    }

    // Cash leg, at the payment's own rate.
    const basePaid = toBase(amount, paymentRate);
    lines.push({
      accountId: paymentAccount.id,
      credit: basePaid,
      description: `Payment to ${vendor.name}`,
      vendorId: vendor.id,
      ...(foreignPayment
        ? { currency: input.currency.toUpperCase(), fxRate: paymentRate, foreignAmount: amount }
        : {}),
    });

    const difference = baseRelievedTotal.minus(basePaid);
    if (!difference.isZero()) {
      const fx = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS, tx);
      lines.push({
        accountId: fx.id,
        // Relieved more payable than cash paid: settling cost less than the
        // liability was booked at, which is a gain.
        credit: difference.isPositive() ? difference : undefined,
        debit: difference.isNegative() ? difference.abs() : undefined,
        description: "Realized FX on settlement",
      });
    }

    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: `Payment to ${vendor.name}`,
        sourceType: "CONSULTANT_PAYMENT",
        sourceId: payment.id,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    return { payment, entry };
  });
}

export async function reverseBillPayment(input: {
  companyId: string;
  billPaymentId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { id: input.billPaymentId, companyId: input.companyId },
      include: { applications: true },
    });
    if (!payment) throw new PostingError("Payment not found in this company");
    if (payment.reversedAt) throw new PostingError("This payment has already been reversed");

    const original = await tx.journalEntry.findFirst({
      where: {
        companyId: input.companyId,
        sourceType: "CONSULTANT_PAYMENT",
        sourceId: payment.id,
      },
      orderBy: { postedAt: "asc" },
    });
    if (!original) throw new PostingError("No posting found for this payment");

    const reversal = await reverseJournalEntry(
      {
        companyId: input.companyId,
        entryId: original.id,
        date: input.date,
        memo: `Reversal of payment ${payment.reference ?? payment.id}`,
        userId: input.userId,
        role: input.role,
      },
      tx,
    );

    // Mark the payment reversed before recomputing anything: the recompute
    // counts live applications, and a payment that is still "live" would leave
    // its documents looking part-paid after their money had been taken back.
    await tx.billPayment.update({
      where: { id: payment.id },
      data: { reversedAt: new Date(), reversalEntryId: reversal.id },
    });

    for (const application of payment.applications) {
      if (application.workOrderId) {
        const workOrder = await tx.workOrder.findUniqueOrThrow({
          where: { id: application.workOrderId },
        });
        const share = money(workOrder.total).isZero()
          ? money(0)
          : toCents(
              money(workOrder.baseTotal)
                .times(money(application.amountApplied))
                .dividedBy(money(workOrder.total)),
            );
        const restored = money(workOrder.baseRelieved).minus(share);
        await tx.workOrder.update({
          where: { id: workOrder.id },
          data: { baseRelieved: restored.isNegative() ? money(0) : restored },
        });
        await recalculateWorkOrder(workOrder.id, tx);
      }

      if (application.expenseId) {
        const expense = await tx.expense.findUniqueOrThrow({ where: { id: application.expenseId } });
        const share = money(expense.amount).isZero()
          ? money(0)
          : toCents(
              money(expense.baseTotal)
                .times(money(application.amountApplied))
                .dividedBy(money(expense.amount)),
            );
        const restoredBase = money(expense.baseRelieved).minus(share);
        const paid = money(expense.amountPaid).minus(money(application.amountApplied));
        const balance = money(expense.amount).minus(paid);
        await tx.expense.update({
          where: { id: expense.id },
          data: {
            baseRelieved: restoredBase.isNegative() ? money(0) : restoredBase,
            amountPaid: paid.isNegative() ? money(0) : paid,
            balanceDue: balance,
            status: paid.lessThanOrEqualTo(0) ? "APPROVED" : "PARTIALLY_PAID",
          },
        });
      }
    }

    return reversal;
  });
}
