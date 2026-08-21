import type { InvoiceStatus, Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import {
  allocateNumber,
  postJournalEntry,
  reverseJournalEntry,
  accountingDate,
} from "@/lib/ledger/post";
import { convertDocument, isBaseCurrency } from "@/lib/ledger/fx";

/**
 * Customer invoices (SPEC §7.1) and their posting rules (SPEC §4.3).
 *
 * The rule that shapes this file: **issuing, not emailing, is what posts.**
 * A draft is not an accounting record and can be edited or thrown away; an
 * issued invoice can only be changed by reversing and reposting.
 */

export type InvoiceLineInput = {
  itemId?: string | null;
  description: string;
  quantity: Prisma.Decimal.Value;
  rate: Prisma.Decimal.Value;
  incomeAccountId: string;
  taxRateId?: string | null;
};

/** Line amount, computed rather than trusted from the form. */
export function computeLine(line: { quantity: Prisma.Decimal.Value; rate: Prisma.Decimal.Value }) {
  return toCents(money(line.quantity).times(money(line.rate)));
}

export async function recalculateTotals(invoiceId: string, tx: Prisma.TransactionClient) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      lines: { include: { taxRate: true } },
      applications: { include: { payment: { select: { reversedAt: true } } } },
    },
  });

  const subtotal = sum(invoice.lines.map((line) => money(line.amount)));
  const taxTotal = sum(
    invoice.lines.map((line) =>
      line.taxRate
        ? toCents(money(line.amount).times(money(line.taxRate.percent)).dividedBy(100))
        : money(0),
    ),
  );
  const total = subtotal.plus(taxTotal);
  const amountPaid = sum(
    invoice.applications
      .filter((application) => !application.payment.reversedAt)
      .map((application) => money(application.amountApplied)),
  );
  const balanceDue = total.minus(amountPaid);

  // Paid states are derived from balanceDue, never set by hand (SPEC §7.1).
  let status: InvoiceStatus = invoice.status;
  if (invoice.status !== "DRAFT" && invoice.status !== "VOID") {
    if (total.greaterThan(0) && balanceDue.lessThanOrEqualTo(0)) status = "PAID";
    else if (amountPaid.greaterThan(0)) status = "PARTIALLY_PAID";
    else status = "ISSUED";
  }

  return tx.invoice.update({
    where: { id: invoiceId },
    data: { subtotal, taxTotal, total, amountPaid, balanceDue, status },
  });
}

/**
 * DRAFT → ISSUED. Allocates the number and posts the entry inside one
 * transaction, which is what keeps the sequence gap-free while still letting
 * drafts be thrown away (SPEC §7.1).
 *
 *   DR  Accounts Receivable      invoice total
 *       CR  Income account(s)        per line, net of tax
 *       CR  Sales Tax Payable        if tax applies
 */
export async function issueInvoice(input: {
  companyId: string;
  invoiceId: string;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId: input.companyId },
      include: { lines: true },
    });
    if (!invoice) throw new PostingError("Invoice not found in this company");
    if (invoice.status !== "DRAFT") throw new PostingError("Only a draft invoice can be issued");
    if (invoice.lines.length === 0) throw new PostingError("An invoice needs at least one line");

    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    await recalculateTotals(invoice.id, tx);
    const fresh = await tx.invoice.findUniqueOrThrow({
      where: { id: invoice.id },
      include: { lines: { include: { taxRate: true }, orderBy: { lineNumber: "asc" } } },
    });

    if (money(fresh.total).lessThanOrEqualTo(0)) {
      throw new PostingError("An invoice must total more than zero");
    }

    const foreign = !isBaseCurrency(fresh.currency, company.baseCurrency);
    const fxRate = foreign ? money(fresh.fxRate) : money(1);
    if (foreign && fxRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency invoice needs an exchange rate");
    }

    const taxByAccount = new Map<string, ReturnType<typeof money>>();
    for (const line of fresh.lines) {
      if (!line.taxRate) continue;
      const tax = toCents(money(line.amount).times(money(line.taxRate.percent)).dividedBy(100));
      const current = taxByAccount.get(line.taxRate.liabilityAccountId) ?? money(0);
      taxByAccount.set(line.taxRate.liabilityAccountId, current.plus(tax));
    }

    const creditParts = [
      ...fresh.lines.map((line) => ({
        accountId: line.incomeAccountId,
        amount: money(line.amount),
        description: line.description,
      })),
      ...[...taxByAccount].map(([accountId, amount]) => ({
        accountId,
        amount,
        description: "Sales tax",
      })),
    ];

    // Convert the document total as the authoritative figure, convert the
    // lines, and post any residual to FX Rounding Difference (SPEC §4.3).
    const converted = convertDocument({
      lines: creditParts,
      amountOf: (part) => part.amount,
      documentTotal: fresh.total,
      fxRate,
    });

    const receivable = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, tx);
    const { formatted } = await allocateNumber(tx, input.companyId, "INVOICE");

    const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [
      {
        accountId: receivable.id,
        debit: converted.baseTotal,
        description: `Invoice ${formatted}`,
        customerId: fresh.customerId,
        ...(foreign ? { currency: fresh.currency, fxRate, foreignAmount: money(fresh.total) } : {}),
      },
      ...converted.baseLines.map((entry) => ({
        accountId: entry.line.accountId,
        credit: entry.baseAmount,
        description: entry.line.description,
        customerId: fresh.customerId,
        ...(foreign ? { currency: fresh.currency, fxRate, foreignAmount: entry.line.amount } : {}),
      })),
    ];

    if (!converted.residual.isZero()) {
      const rounding = await systemAccount(
        input.companyId,
        SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE,
        tx,
      );
      lines.push({
        accountId: rounding.id,
        // A/R is debited with the authoritative converted total, so when that
        // total exceeds the summed income lines the entry is short of credits
        // by exactly the residual — and vice versa. Never absorb this into a
        // revenue line (SPEC §4.3).
        credit: converted.residual.isPositive() ? converted.residual : undefined,
        debit: converted.residual.isNegative() ? converted.residual.abs() : undefined,
        description: "FX rounding difference",
      });
    }

    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(fresh.issueDate),
        memo: `Invoice ${formatted}`,
        sourceType: "INVOICE",
        sourceId: fresh.id,
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    const updated = await tx.invoice.update({
      where: { id: fresh.id },
      data: {
        invoiceNumber: formatted,
        status: "ISSUED",
        issuedAt: new Date(),
        baseTotal: converted.baseTotal,
      },
      include: { lines: true },
    });

    return { invoice: updated, entry };
  });
}

/**
 * VOID posts a full reversal and keeps the number reserved (SPEC §7.1).
 * Voiding a document with payments applied is blocked — reverse the payments
 * first, so cash never disappears silently.
 */
export async function voidInvoice(input: {
  companyId: string;
  invoiceId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId: input.companyId },
      include: { applications: { include: { payment: true } } },
    });
    if (!invoice) throw new PostingError("Invoice not found in this company");
    if (invoice.status === "VOID") throw new PostingError("This invoice is already void");
    if (invoice.status === "DRAFT") throw new PostingError("A draft is deleted, not voided");

    const live = invoice.applications.filter((application) => !application.payment.reversedAt);
    if (live.length > 0) {
      throw new PostingError(
        "This invoice has payments applied. Reverse them before voiding it, so the cash is accounted for.",
      );
    }

    const original = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "INVOICE", sourceId: invoice.id },
      orderBy: { postedAt: "asc" },
    });
    if (original && !original.reversedByEntryId) {
      await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: original.id,
          date: input.date,
          memo: `Void of invoice ${invoice.invoiceNumber}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
    }

    return tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "VOID", voidedAt: new Date(), balanceDue: 0, baseRelieved: 0 },
    });
  });
}

/** A draft is not an accounting record, so it can be deleted outright. */
export async function deleteDraftInvoice(companyId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, companyId } });
  if (!invoice) throw new PostingError("Invoice not found in this company");
  if (invoice.status !== "DRAFT") {
    throw new PostingError("Only a draft can be deleted. Issued invoices are voided, never removed.");
  }
  await prisma.invoice.delete({ where: { id: invoiceId } });
}
