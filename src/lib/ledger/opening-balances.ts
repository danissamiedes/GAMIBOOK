import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { money, sum, toCents } from "@/lib/money";
import { normalBalance, isBalanceSheet, SYSTEM_ACCOUNTS } from "./accounts";
import { systemAccount } from "./chart";
import { postJournalEntry, accountingDate } from "./post";

/**
 * Opening balances (SPEC §4.3): a single OPENING_BALANCE entry per company,
 * with the balancing figure posted to Opening Balance Equity.
 *
 * Balances are entered on each account's normal side — a positive figure
 * against a bank account is a debit, against a liability a credit — because
 * that is how they appear on the statement being copied from.
 */

export type OpeningBalanceInput = {
  companyId: string;
  date: Date;
  balances: { accountId: string; amount: Prisma.Decimal.Value }[];
  memo?: string | null;
  userId?: string | null;
  role?: Role | null;
};

export async function postOpeningBalances(input: OpeningBalanceInput) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.journalEntry.findFirst({
      where: { companyId: input.companyId, sourceType: "OPENING_BALANCE" },
    });
    if (existing) {
      throw new PostingError(
        "Opening balances have already been posted. Adjust them with a manual journal entry.",
      );
    }

    const accountIds = input.balances.map((balance) => balance.accountId);
    const accounts = await tx.account.findMany({
      where: { id: { in: accountIds }, companyId: input.companyId },
    });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const lines: { accountId: string; debit?: Prisma.Decimal.Value; credit?: Prisma.Decimal.Value; description: string }[] = [];

    for (const balance of input.balances) {
      const account = accountsById.get(balance.accountId);
      if (!account) throw new PostingError("Account not found in this company");

      const amount = toCents(money(balance.amount));
      if (amount.isZero()) continue;

      if (!isBalanceSheet(account.type)) {
        // Income and expense accounts have no opening balance: prior-year
        // results belong in retained earnings, computed at report time.
        throw new PostingError(
          `${account.code} ${account.name} is an income statement account and cannot carry an opening balance`,
        );
      }
      if (account.systemKey === SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY) {
        throw new PostingError("Opening Balance Equity is the balancing figure, not an input");
      }

      // A positive amount sits on the account's normal side; a negative one
      // (an overdrawn bank account, say) flips to the other side.
      const debitNormal = normalBalance(account.type) === "DEBIT";
      const magnitude = amount.abs();
      const onDebitSide = amount.isPositive() ? debitNormal : !debitNormal;

      lines.push({
        accountId: account.id,
        debit: onDebitSide ? magnitude : undefined,
        credit: onDebitSide ? undefined : magnitude,
        description: "Opening balance",
      });
    }

    if (lines.length === 0) throw new PostingError("Enter at least one opening balance");

    const debitTotal = sum(lines.map((line) => money(line.debit ?? 0)));
    const creditTotal = sum(lines.map((line) => money(line.credit ?? 0)));
    const difference = debitTotal.minus(creditTotal);

    if (!difference.isZero()) {
      const equity = await systemAccount(
        input.companyId,
        SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY,
        tx,
      );
      lines.push({
        accountId: equity.id,
        // Debits exceed credits, so the plug is a credit, and vice versa.
        debit: difference.isNegative() ? difference.abs() : undefined,
        credit: difference.isPositive() ? difference : undefined,
        description: "Opening balance equity",
      });
    }

    return postJournalEntry(
      {
        companyId: input.companyId,
        date: accountingDate(input.date),
        memo: input.memo ?? "Opening balances",
        sourceType: "OPENING_BALANCE",
        userId: input.userId,
        role: input.role,
        lines,
      },
      tx,
    );
  });
}
