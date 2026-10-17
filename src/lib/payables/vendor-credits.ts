import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents, type Money } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { systemAccount } from "@/lib/ledger/chart";
import { accountingDate, postJournalEntry, reverseJournalEntry } from "@/lib/ledger/post";
import { reconciliationLock } from "@/lib/bank/reconcile";
import { isBaseCurrency, toBase } from "@/lib/ledger/fx";

/**
 * Credit notes from suppliers and consultants (SPEC §8.5).
 *
 * Money a party owes back, or agrees not to charge: a returned delivery, a
 * line billed twice, a discount agreed after the invoice. Two steps, and
 * only the first one posts.
 *
 *   **Recording** debits accounts payable and credits the account the cost
 *   went to. That is the moment what is owed changes, whether or not anybody
 *   has decided yet which bill it answers.
 *
 *   **Applying** it to a bill posts nothing. Both documents are already in
 *   A/P; the application says which bill the credit pays off, so the bill
 *   stops being chased and the aging reads correctly.
 *
 * A credit is kept apart from `amountPaid` on the bill, in `creditedAmount`,
 * because it is not money: a bill settled by a credit note was never paid,
 * and a cash-flow report that said otherwise would be lying.
 */

export async function recordVendorCredit(input: {
  companyId: string;
  vendorId: string;
  date: Date;
  /** The party's own credit note number. Required, as on a bill. */
  reference: string;
  currency: string;
  fxRate?: Prisma.Decimal.Value;
  amount: Prisma.Decimal.Value;
  /** The account the credit reverses — normally the bill's own. */
  expenseAccountId: string;
  memo?: string | null;
  userId?: string | null;
  role?: Role | null;
}) {
  const reference = input.reference?.trim();
  if (!reference) {
    throw new PostingError("A reference number is required — the credit note's own number");
  }

  return prisma.$transaction(async (tx) => {
    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { baseCurrency: true },
    });

    const amount = toCents(money(input.amount));
    if (amount.lessThanOrEqualTo(0)) {
      throw new PostingError("A credit note must be more than zero");
    }

    const vendor = await tx.vendor.findFirst({
      where: { id: input.vendorId, companyId: input.companyId },
    });
    if (!vendor) throw new PostingError("Party not found in this company");

    const account = await tx.account.findFirst({
      where: { id: input.expenseAccountId, companyId: input.companyId, isActive: true },
    });
    if (!account) throw new PostingError("Account not found in this company");

    const foreign = !isBaseCurrency(input.currency, company.baseCurrency);
    const fxRate = foreign ? money(input.fxRate ?? 0) : money(1);
    if (foreign && fxRate.lessThanOrEqualTo(0)) {
      throw new PostingError("A foreign-currency credit note needs an exchange rate");
    }
    const baseTotal = toBase(amount, fxRate);

    const credit = await tx.vendorCredit.create({
      data: {
        companyId: input.companyId,
        vendorId: vendor.id,
        date: accountingDate(input.date),
        reference,
        currency: input.currency.toUpperCase(),
        fxRate,
        amount,
        baseTotal,
        balance: amount,
        expenseAccountId: account.id,
        memo: input.memo?.trim() || null,
        createdByUserId: input.userId ?? null,
      },
    });

    const payable = await systemAccount(input.companyId, SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE, tx);
    const entry = await postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: `Credit note ${reference} from ${vendor.name}`,
        sourceType: "VENDOR_CREDIT",
        sourceId: credit.id,
        userId: input.userId,
        role: input.role,
        lines: [
          {
            // What is owed goes down, which is a debit to payables.
            accountId: payable.id,
            debit: baseTotal,
            description: `Credit note ${reference}`,
            vendorId: vendor.id,
            ...(foreign ? { currency: input.currency.toUpperCase(), fxRate, foreignAmount: amount } : {}),
          },
          {
            accountId: account.id,
            credit: baseTotal,
            description: input.memo?.trim() || `Credit note ${reference}`,
            vendorId: vendor.id,
            ...(foreign ? { currency: input.currency.toUpperCase(), fxRate, foreignAmount: amount } : {}),
          },
        ],
      },
      tx,
    );

    return { credit, entry };
  });
}

/** The bills this party still owes money on, newest due first. */
export async function openBillsForCredit(companyId: string, vendorId: string) {
  const bills = await prisma.expense.findMany({
    where: {
      companyId,
      vendorId,
      kind: "BILL",
      status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      balanceDue: { gt: 0 },
    },
    orderBy: [{ dueDate: "asc" }, { date: "asc" }],
    select: {
      id: true,
      description: true,
      reference: true,
      date: true,
      dueDate: true,
      currency: true,
      balanceDue: true,
    },
  });
  return bills;
}

/**
 * Set a credit against one or more bills. Posts nothing — see the note at the
 * top of this file — but it does move both documents' balances.
 */
export async function applyVendorCredit(input: {
  companyId: string;
  vendorCreditId: string;
  applications: { expenseId: string; amountApplied: Prisma.Decimal.Value }[];
  userId?: string | null;
}) {
  if (input.applications.length === 0) {
    throw new PostingError("Choose at least one bill to apply this credit to");
  }

  return prisma.$transaction(async (tx) => {
    const credit = await tx.vendorCredit.findFirst({
      where: { id: input.vendorCreditId, companyId: input.companyId },
    });
    if (!credit) throw new PostingError("Credit note not found in this company");
    if (credit.status === "VOID") throw new PostingError("A void credit note cannot be applied");

    const requested = sum(input.applications.map((row) => toCents(money(row.amountApplied))));
    if (requested.lessThanOrEqualTo(0)) throw new PostingError("Enter an amount to apply");
    if (requested.greaterThan(money(credit.balance))) {
      throw new PostingError(
        `That credit has ${money(credit.balance).toFixed(2)} left; you are applying ${requested.toFixed(2)}.`,
      );
    }

    for (const application of input.applications) {
      const amount = toCents(money(application.amountApplied));
      if (amount.lessThanOrEqualTo(0)) continue;

      const bill = await tx.expense.findFirst({
        where: {
          id: application.expenseId,
          companyId: input.companyId,
          vendorId: credit.vendorId,
          kind: "BILL",
        },
      });
      if (!bill) throw new PostingError("That bill is not this party's, or is not a bill");
      if (bill.status === "VOID") throw new PostingError("A void bill cannot take a credit");
      if (bill.currency !== credit.currency) {
        // Applying across currencies would need a rate and would post a gain
        // or loss; a credit note that posts nothing must not do that quietly.
        throw new PostingError(
          `The credit is in ${credit.currency} and that bill is in ${bill.currency}. Record the credit in the bill's currency.`,
        );
      }
      if (amount.greaterThan(money(bill.balanceDue))) {
        throw new PostingError(
          `${bill.reference ?? bill.description} has ${money(bill.balanceDue).toFixed(2)} outstanding; you are applying ${amount.toFixed(2)}.`,
        );
      }

      const credited = money(bill.creditedAmount).plus(amount);
      const balance = money(bill.amount).minus(money(bill.amountPaid)).minus(credited);
      // The credit note's own posting has already debited A/P by its share,
      // so the bill has that much less left to relieve. Without this, a
      // payment that settles the rest would relieve the whole document and
      // leave payables with a debit balance.
      const share = money(bill.amount).isZero()
        ? money(0)
        : toCents(money(bill.baseTotal).times(amount).dividedBy(money(bill.amount)));
      await tx.expense.update({
        where: { id: bill.id },
        data: {
          creditedAmount: credited,
          baseRelieved: money(bill.baseRelieved).plus(share),
          balanceDue: balance,
          // Settled is settled, however it was settled.
          status: balance.lessThanOrEqualTo(0) ? "PAID" : "PARTIALLY_PAID",
        },
      });

      await tx.vendorCreditApplication.create({
        data: {
          vendorCreditId: credit.id,
          expenseId: bill.id,
          amountApplied: amount,
        },
      });
    }

    const applied = money(credit.amountApplied).plus(requested);
    const balance = money(credit.amount).minus(applied);
    return tx.vendorCredit.update({
      where: { id: credit.id },
      data: {
        amountApplied: applied,
        balance,
        status: balance.lessThanOrEqualTo(0) ? "APPLIED" : "PARTIALLY_APPLIED",
      },
    });
  });
}

/** Take a credit back off the bills it was set against. Still posts nothing. */
export async function unapplyVendorCredit(input: {
  companyId: string;
  vendorCreditId: string;
  applicationId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const application = await tx.vendorCreditApplication.findFirst({
      where: {
        id: input.applicationId,
        vendorCreditId: input.vendorCreditId,
        vendorCredit: { companyId: input.companyId },
      },
      include: { vendorCredit: true, expense: true },
    });
    if (!application) throw new PostingError("That application was not found");

    const bill = application.expense;
    const credited = money(bill.creditedAmount).minus(money(application.amountApplied));
    const share = money(bill.amount).isZero()
      ? money(0)
      : toCents(
          money(bill.baseTotal)
            .times(money(application.amountApplied))
            .dividedBy(money(bill.amount)),
        );
    const restoredBase = money(bill.baseRelieved).minus(share);
    const balance = money(bill.amount)
      .minus(money(bill.amountPaid))
      .minus(credited.isNegative() ? money(0) : credited);
    await tx.expense.update({
      where: { id: bill.id },
      data: {
        creditedAmount: credited.isNegative() ? money(0) : credited,
        baseRelieved: restoredBase.isNegative() ? money(0) : restoredBase,
        balanceDue: balance,
        status: balance.lessThanOrEqualTo(0)
          ? "PAID"
          : money(bill.amountPaid).greaterThan(0) || credited.greaterThan(0)
            ? "PARTIALLY_PAID"
            : "APPROVED",
      },
    });

    const credit = application.vendorCredit;
    const applied = money(credit.amountApplied).minus(money(application.amountApplied));
    const left = money(credit.amount).minus(applied.isNegative() ? money(0) : applied);
    await tx.vendorCreditApplication.delete({ where: { id: application.id } });

    return tx.vendorCredit.update({
      where: { id: credit.id },
      data: {
        amountApplied: applied.isNegative() ? money(0) : applied,
        balance: left,
        status: applied.lessThanOrEqualTo(0)
          ? "OPEN"
          : left.lessThanOrEqualTo(0)
            ? "APPLIED"
            : "PARTIALLY_APPLIED",
      },
    });
  });
}

/**
 * Void a credit note: reverse its posting, keep the document.
 *
 * Refused while any of it is still set against a bill — taking the credit
 * out from under a bill that is relying on it would leave that bill paid by
 * nothing.
 */
export async function voidVendorCredit(input: {
  companyId: string;
  vendorCreditId: string;
  date: Date;
  userId?: string | null;
  role?: Role | null;
}) {
  return prisma.$transaction(async (tx) => {
    const credit = await tx.vendorCredit.findFirst({
      where: { id: input.vendorCreditId, companyId: input.companyId },
      include: { applications: true },
    });
    if (!credit) throw new PostingError("Credit note not found in this company");
    if (credit.status === "VOID") throw new PostingError("This credit note is already void");
    if (credit.applications.length > 0) {
      throw new PostingError(
        "This credit is applied to a bill. Take it off that bill first, then void it.",
      );
    }

    const original = await tx.journalEntry.findFirst({
      where: {
        companyId: input.companyId,
        sourceType: "VENDOR_CREDIT",
        sourceId: credit.id,
      },
      orderBy: { postedAt: "asc" },
    });
    if (original && !original.reversedByEntryId) {
      // The same guard an amendment and a voided expense use: an entry
      // cleared on a signed-off statement cannot be reversed under it
      // (SPEC §8.4a).
      const reconciled = await reconciliationLock(input.companyId, original.id, tx);
      if (reconciled) throw new PostingError(reconciled);

      await reverseJournalEntry(
        {
          companyId: input.companyId,
          entryId: original.id,
          date: accountingDate(input.date),
          memo: `Void of credit note ${credit.reference}`,
          userId: input.userId,
          role: input.role,
        },
        tx,
      );
    }

    return tx.vendorCredit.update({
      where: { id: credit.id },
      data: { status: "VOID", voidedAt: new Date(), balance: 0 },
    });
  });
}

/** What a party's unused credit adds up to, for the screens that say so. */
export function creditBalance(credits: { balance: Prisma.Decimal }[]): Money {
  return sum(credits.map((credit) => money(credit.balance)));
}
