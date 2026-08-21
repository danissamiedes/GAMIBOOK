import type { AccountSubtype } from "@prisma/client";
import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { fiscalYearStart } from "@/lib/dates";
import { balancesByAccount, netIncomeForPeriod, type AccountBalanceRow } from "./balances";

/**
 * Balance Sheet (SPEC §12.2).
 *
 * Equity is where balance sheets go wrong, and this system posts no closing
 * entries, so the rule is spelled out and followed exactly:
 *
 *   FY                    = the fiscal year CONTAINING the as-of date — not the
 *                           current one, or every historical report is wrong
 *   Net income (current)  = income − expenses from FY.start through as-of
 *   Retained earnings     = the RE account's own balance (migration entries
 *                           only) PLUS income − expenses for ALL postings dated
 *                           before FY.start, back to the beginning of time
 *   Equity                = other equity + Opening Balance Equity + RE + NI
 *
 * Taking retained earnings from the account balance alone silently drops every
 * prior year's profit from the second fiscal year onward. The test for this
 * spans a fiscal-year boundary, because seed data that does not cannot catch it.
 */

export type BsGroup = {
  key: string;
  label: string;
  rows: AccountBalanceRow[];
  total: Money;
};

export type BalanceSheet = {
  asOf: Date;
  fiscalYearStart: Date;
  assets: { current: BsGroup; fixed: BsGroup; total: Money };
  liabilities: { current: BsGroup; longTerm: BsGroup; total: Money };
  equity: {
    accounts: AccountBalanceRow[];
    contributed: Money;
    openingBalanceEquity: Money;
    retainedEarnings: Money;
    /** What the RE account itself holds, before the roll-forward. */
    retainedEarningsPosted: Money;
    /** Prior-year profits rolled forward from the ledger. */
    priorYearEarnings: Money;
    netIncome: Money;
    total: Money;
  };
  liabilitiesAndEquity: Money;
  difference: Money;
  balanced: boolean;
};

const CURRENT_ASSET_SUBTYPES: AccountSubtype[] = [
  "CASH",
  "UNDEPOSITED_FUNDS",
  "ACCOUNTS_RECEIVABLE",
  "OTHER_CURRENT_ASSET",
];
const CURRENT_LIABILITY_SUBTYPES: AccountSubtype[] = [
  "ACCOUNTS_PAYABLE",
  "CREDIT_CARD",
  "OTHER_CURRENT_LIABILITY",
];

function group(key: string, label: string, rows: AccountBalanceRow[]): BsGroup {
  return {
    key,
    label,
    rows,
    total: rows.reduce<Money>((total, row) => total.plus(row.amount), money(0)),
  };
}

export async function balanceSheet(options: {
  companyId: string;
  asOf: Date;
  includeZeroRows?: boolean;
}): Promise<BalanceSheet> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: options.companyId },
    select: { fiscalYearStartMonth: true },
  });

  const fyStart = fiscalYearStart(options.asOf, company.fiscalYearStartMonth);
  const dayBeforeFy = new Date(fyStart.getTime() - 86_400_000);

  const [balanceSheetRows, currentYearNet, priorYearEarnings] = await Promise.all([
    balancesByAccount({
      companyId: options.companyId,
      to: options.asOf,
      types: ["ASSET", "LIABILITY", "EQUITY"],
    }),
    netIncomeForPeriod({ companyId: options.companyId, from: fyStart, to: options.asOf }),
    // Everything before this fiscal year, back to the beginning of time.
    netIncomeForPeriod({ companyId: options.companyId, to: dayBeforeFy }),
  ]);

  const visible = (rows: AccountBalanceRow[]) =>
    rows.filter((row) => options.includeZeroRows || !row.amount.isZero());

  const assetRows = visible(balanceSheetRows.filter((row) => row.type === "ASSET"));
  const liabilityRows = visible(balanceSheetRows.filter((row) => row.type === "LIABILITY"));
  const equityRows = balanceSheetRows.filter((row) => row.type === "EQUITY");

  const currentAssets = group(
    "current-assets",
    "Current assets",
    assetRows.filter((row) => CURRENT_ASSET_SUBTYPES.includes(row.subtype)),
  );
  const fixedAssets = group(
    "fixed-assets",
    "Fixed assets",
    assetRows.filter((row) => row.subtype === "FIXED_ASSET"),
  );
  const currentLiabilities = group(
    "current-liabilities",
    "Current liabilities",
    liabilityRows.filter((row) => CURRENT_LIABILITY_SUBTYPES.includes(row.subtype)),
  );
  const longTermLiabilities = group(
    "long-term-liabilities",
    "Long-term liabilities",
    liabilityRows.filter((row) => row.subtype === "LONG_TERM_LIABILITY"),
  );

  // Retained Earnings and Opening Balance Equity are reported as their own
  // lines, so they are pulled out of the ordinary equity accounts.
  const retainedAccount = equityRows.find(
    (row) => row.subtype === "RETAINED_EARNINGS",
  );
  const openingBalanceRow = equityRows.find((row) => row.name === "Opening Balance Equity");

  const contributedRows = visible(
    equityRows.filter(
      (row) =>
        row.subtype !== "RETAINED_EARNINGS" && row.accountId !== openingBalanceRow?.accountId,
    ),
  );

  const retainedEarningsPosted = retainedAccount?.amount ?? money(0);
  const retainedEarnings = retainedEarningsPosted.plus(priorYearEarnings);
  const openingBalanceEquity = openingBalanceRow?.amount ?? money(0);
  const contributed = contributedRows.reduce<Money>(
    (total, row) => total.plus(row.amount),
    money(0),
  );

  const equityTotal = contributed
    .plus(openingBalanceEquity)
    .plus(retainedEarnings)
    .plus(currentYearNet);

  const assetsTotal = currentAssets.total.plus(fixedAssets.total);
  const liabilitiesTotal = currentLiabilities.total.plus(longTermLiabilities.total);
  const liabilitiesAndEquity = liabilitiesTotal.plus(equityTotal);
  const difference = assetsTotal.minus(liabilitiesAndEquity);

  return {
    asOf: options.asOf,
    fiscalYearStart: fyStart,
    assets: { current: currentAssets, fixed: fixedAssets, total: assetsTotal },
    liabilities: {
      current: currentLiabilities,
      longTerm: longTermLiabilities,
      total: liabilitiesTotal,
    },
    equity: {
      accounts: contributedRows,
      contributed,
      openingBalanceEquity,
      retainedEarnings,
      retainedEarningsPosted,
      priorYearEarnings,
      netIncome: currentYearNet,
      total: equityTotal,
    },
    liabilitiesAndEquity,
    difference,
    balanced: difference.isZero(),
  };
}

export { SYSTEM_ACCOUNTS };
