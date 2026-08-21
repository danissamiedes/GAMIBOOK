import type { PaymentMethod, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { postJournalEntry, reverseJournalEntry, accountingDate } from "@/lib/ledger/post";
import { isBaseCurrency, relieveProRata, toBase } from "@/lib/ledger/fx";
import { recalculateTotals } from "./service";

/**
 * Payments received from clients (SPEC §7.1) and the settlement posting
 * (SPEC §4.3):
 *
 *   DR  Bank / Undeposited Funds   amount received, at the PAYMENT's rate
 *       CR  Accounts Receivable        amount applied, at the INVOICE's rate
 *   DR/CR  Realized FX Gain/Loss       the difference, if any
 *
 * The receivable is relieved at the **invoice's** historic rate, never the
 * payment's. That is the whole point: A/R was recorded in base currency at
 * issue and must come off at exactly that amount, or the control account never
 * clears to zero. One control-account line per invoice, each at its own rate.
 */

export type PaymentApplicationInput = { invoiceId: string; amountApplied: Prisma.Decimal.Value };

export async function recordPayment(input: {
  companyId: string;
  customerId: string;
  date: Date;
  amount: Prisma.Decimal.Value;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  depositAccountId: string;
  method?: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  applications: PaymentApplicationInput[];
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

    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, companyId: input.companyId },
    });
    if (!customer) throw new PostingError("Customer not found in this company");

    const deposit = await tx.account.findFirst({
      where: { id: input.depositAccountId, companyId: input.companyId, isActive: true },
    });
    if (!deposit) throw new PostingError("Deposit account not found in this company");

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

    const payment = await tx.payment.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        date: accountingDate(input.date),
        amount,
        currency: input.currency.toUpperCase(),
        fxRate: paymentRate,
        depositAccountId: deposit.id,
        method: input.method ?? "BANK_TRANSFER",
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
    });

    const receivable = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, tx);
    const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [];

    // Cash leg, at the payment's own rate.
    const baseReceived = toBase(amount, paymentRate);
    lines.push({
      accountId: deposit.id,
      debit: baseReceived,
      description: `Payment from ${customer.name}`,
      customerId: customer.id,
      ...(foreignPayment
        ? { currency: input.currency.toUpperCase(), fxRate: paymentRate, foreignAmount: amount }
        : {}),
    });

    let baseRelievedTotal = money(0);

    for (const application of input.applications) {
      const applicationAmount = toCents(money(application.amountApplied));
      if (applicationAmount.lessThanOrEqualTo(0)) {
        throw new PostingError("Each application must be more than zero");
      }

      const invoice = await tx.invoice.findFirst({
        where: { id: application.invoiceId, companyId: input.companyId },
      });
      if (!invoice) throw new PostingError("Invoice not found in this company");
      if (invoice.status === "DRAFT") {
        throw new PostingError(`Invoice ${invoice.id} is still a draft — issue it before paying it`);
      }
      if (invoice.status === "VOID") throw new PostingError("A void invoice cannot be paid");
      if (invoice.currency !== input.currency.toUpperCase()) {
        throw new PostingError(
          `Payment is in ${input.currency} but invoice ${invoice.invoiceNumber} is in ${invoice.currency}`,
        );
      }
      if (applicationAmount.greaterThan(money(invoice.balanceDue))) {
        throw new PostingError(
          `Applying ${applicationAmount.toFixed(2)} to invoice ${invoice.invoiceNumber} exceeds its balance of ${money(
            invoice.balanceDue,
          ).toFixed(2)}`,
        );
      }

      const settles = money(invoice.balanceDue).minus(applicationAmount).lessThanOrEqualTo(0);

      // Pro rata at the INVOICE's rate; the final payment takes the residual
      // so the document's base balance lands exactly on zero.
      const baseRelieved = relieveProRata({
        documentBaseTotal: invoice.baseTotal,
        alreadyRelieved: invoice.baseRelieved,
        documentForeignTotal: invoice.total,
        foreignApplied: applicationAmount,
        settlesDocument: settles,
      });

      baseRelievedTotal = baseRelievedTotal.plus(baseRelieved);

      lines.push({
        accountId: receivable.id,
        credit: baseRelieved,
        description: `Invoice ${invoice.invoiceNumber}`,
        customerId: customer.id,
        ...(invoice.currency !== company.baseCurrency
          ? {
              currency: invoice.currency,
              fxRate: money(invoice.fxRate),
              foreignAmount: applicationAmount,
            }
          : {}),
      });

      await tx.paymentApplication.create({
        data: {
          paymentId: payment.id,
          invoiceId: invoice.id,
          amountApplied: applicationAmount,
        },
      });

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { baseRelieved: money(invoice.baseRelieved).plus(baseRelieved) },
      });

      await recalculateTotals(invoice.id, tx);
    }

    // Anything not applied is a credit on account — shown, never discarded.
    const unapplied = amount.minus(applied);
    if (unapplied.greaterThan(0)) {
      lines.push({
        accountId: receivable.id,
        credit: toBase(unapplied, paymentRate),
        description: "Unapplied — credit on account",
        customerId: customer.id,
        ...(foreignPayment
          ? {
              currency: input.currency.toUpperCase(),
              fxRate: paymentRate,
              foreignAmount: unapplied,
            }
          : {}),
      });
      baseRelievedTotal = baseRelievedTotal.plus(toBase(unapplied, paymentRate));
    }

    // Whatever the two legs disagree about is realized FX (SPEC §4.3).
    const difference = baseReceived.minus(baseRelievedTotal);
    if (!difference.isZero()) {
      const fx = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.REALIZED_FX_GAIN_LOSS, tx);
      lines.push({
        accountId: fx.id,
        // More cash than receivable relieved: a gain, which is a credit.
        credit: difference.isPositive() ? difference : undefined,
        debit: difference.isNegative() ? difference.abs() : undefined,
        description: "Realized FX on settlement",
      });
    }

    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: `Payment from ${customer.name}`,
        sourceType: "INVOICE_PAYMENT",
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

/**
 * Reversing a payment posts a reversing entry, deletes nothing, and recomputes
 * every invoice it touched (SPEC §7.1).
 */
export async function reversePayment(input: {
  companyId: string;
  paymentId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: input.paymentId, companyId: input.companyId },
      include: { applications: true },
    });
    if (!payment) throw new PostingError("Payment not found in this company");
    if (payment.reversedAt) throw new PostingError("This payment has already been reversed");

    const original = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "INVOICE_PAYMENT", sourceId: payment.id },
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

    // Give each invoice back the base amount this payment had relieved, so a
    // later payment relieves the right share at the document's rate.
    for (const application of payment.applications) {
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: application.invoiceId } });
      const share = money(invoice.total).isZero()
        ? money(0)
        : toCents(
            money(invoice.baseTotal)
              .times(money(application.amountApplied))
              .dividedBy(money(invoice.total)),
          );
      const restored = money(invoice.baseRelieved).minus(share);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { baseRelieved: restored.isNegative() ? money(0) : restored },
      });
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: { reversedAt: new Date(), reversalEntryId: reversal.id },
    });

    for (const application of payment.applications) {
      await recalculateTotals(application.invoiceId, tx);
    }

    return reversal;
  });
}
