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
import { amendPosting } from "@/lib/ledger/amend";

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
/**
 * The journal lines an invoice posts, built from the invoice as it currently
 * stands: DR A/R for the converted total, CR each income line and each tax
 * account, with any conversion residual to FX Rounding Difference (SPEC §4.3).
 *
 * Shared by issuing and by editing an issued invoice. It has to be shared: two
 * copies of this would drift, and the way they would drift is that a corrected
 * invoice stops matching the one it replaced by a rounding cent.
 */
async function invoicePostingLines(
  tx: Prisma.TransactionClient,
  companyId: string,
  invoiceId: string,
  label: string,
) {
  const company = await tx.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { baseCurrency: true },
  });

  await recalculateTotals(invoiceId, tx);
  const fresh = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
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

  const receivable = await systemAccount(companyId, SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE, tx);

  const lines: Parameters<typeof postJournalEntry>[0]["lines"] = [
    {
      accountId: receivable.id,
      debit: converted.baseTotal,
      description: `Invoice ${label}`,
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
    const rounding = await systemAccount(companyId, SYSTEM_ACCOUNTS.FX_ROUNDING_DIFFERENCE, tx);
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

  return { lines, baseTotal: converted.baseTotal, fresh };
}

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

    const { formatted } = await allocateNumber(tx, input.companyId, "INVOICE");
    const { lines, baseTotal, fresh } = await invoicePostingLines(
      tx,
      input.companyId,
      invoice.id,
      formatted,
    );

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
        baseTotal,
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

/**
 * Edit an invoice (SPEC §7.1).
 *
 *   DRAFT   — changed freely. A draft is not an accounting record, so nothing
 *             is posted, nothing is reversed, and the lines are simply
 *             replaced.
 *   ISSUED  — reversed and reposted (SPEC §4.2 rule 3). The invoice keeps its
 *             number: the document the customer received is still that
 *             invoice, now saying something different.
 *
 * Blocked entirely once payments are applied, which SPEC §7.1 requires and
 * which is the right answer anyway — moving the total under a payment leaves
 * the invoice and the cash that settled it disagreeing.
 */
export async function updateInvoice(input: {
  companyId: string;
  invoiceId: string;
  customerId?: string;
  issueDate?: Date;
  dueDate?: Date;
  currency?: string;
  fxRate?: Prisma.Decimal.Value;
  terms?: string | null;
  lines: InvoiceLineInput[];
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: input.invoiceId, companyId: input.companyId },
      include: { applications: { include: { payment: { select: { reversedAt: true } } } } },
    });
    if (!invoice) throw new PostingError("Invoice not found in this company");
    if (invoice.status === "VOID") {
      throw new PostingError("A void invoice cannot be edited. Raise a new one instead.");
    }
    if (input.lines.length === 0) throw new PostingError("An invoice needs at least one line");

    const live = invoice.applications.filter((application) => !application.payment.reversedAt);
    if (live.length > 0) {
      throw new PostingError(
        "This invoice has payments applied. Reverse them first, then edit it.",
      );
    }

    if (input.customerId && input.customerId !== invoice.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, companyId: input.companyId },
      });
      if (!customer) throw new PostingError("Customer not found in this company");
    }

    // Replaced wholesale rather than diffed. Line numbers are positional and a
    // diff would have to renumber anyway, so rewriting is both simpler and the
    // only version that cannot leave a stale line behind.
    await tx.invoiceLine.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        customerId: input.customerId ?? invoice.customerId,
        issueDate: input.issueDate ? accountingDate(input.issueDate) : invoice.issueDate,
        dueDate: input.dueDate ? accountingDate(input.dueDate) : invoice.dueDate,
        currency: input.currency ? input.currency.toUpperCase() : invoice.currency,
        fxRate: input.fxRate ?? invoice.fxRate,
        terms: input.terms === undefined ? invoice.terms : input.terms,
        lines: {
          create: input.lines.map((line, index) => ({
            lineNumber: index + 1,
            itemId: line.itemId ?? null,
            description: line.description,
            quantity: line.quantity,
            rate: line.rate,
            amount: computeLine(line),
            incomeAccountId: line.incomeAccountId,
            taxRateId: line.taxRateId ?? null,
          })),
        },
      },
    });

    if (invoice.status === "DRAFT") {
      await recalculateTotals(invoice.id, tx);
      return tx.invoice.findUniqueOrThrow({
        where: { id: invoice.id },
        include: { lines: { orderBy: { lineNumber: "asc" } } },
      });
    }

    const { lines, baseTotal, fresh } = await invoicePostingLines(
      tx,
      input.companyId,
      invoice.id,
      invoice.invoiceNumber ?? "draft",
    );

    await amendPosting(
      {
        companyId: input.companyId,
        sourceType: "INVOICE",
        sourceId: invoice.id,
        date: accountingDate(fresh.issueDate),
        memo: `Invoice ${invoice.invoiceNumber ?? ""}`.trim(),
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );

    return tx.invoice.update({
      where: { id: invoice.id },
      data: { baseTotal },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    });
  });
}
