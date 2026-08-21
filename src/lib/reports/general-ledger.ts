import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { normalBalance } from "@/lib/ledger/accounts";

/**
 * General Ledger / account detail (SPEC §12.4) — every line hitting an account
 * in a period, with a running balance, opened from any figure on any report.
 */

export type LedgerLine = {
  lineId: string;
  entryId: string;
  entryNumber: number;
  date: Date;
  memo: string | null;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  partyName: string | null;
  debit: Money;
  credit: Money;
  runningBalance: Money;
};

export async function accountDetail(options: {
  companyId: string;
  accountId: string;
  from?: Date | null;
  to: Date;
}) {
  const account = await prisma.account.findFirstOrThrow({
    where: { id: options.accountId, companyId: options.companyId },
  });

  const [openingSums, lines] = await Promise.all([
    options.from
      ? prisma.journalLine.aggregate({
          where: {
            accountId: account.id,
            entry: { companyId: options.companyId, date: { lt: options.from } },
          },
          _sum: { debit: true, credit: true },
        })
      : Promise.resolve({ _sum: { debit: null, credit: null } }),
    prisma.journalLine.findMany({
      where: {
        accountId: account.id,
        entry: {
          companyId: options.companyId,
          date: { lte: options.to, ...(options.from ? { gte: options.from } : {}) },
        },
      },
      include: {
        entry: {
          select: {
            id: true,
            entryNumber: true,
            date: true,
            memo: true,
            sourceType: true,
            sourceId: true,
          },
        },
        customer: { select: { name: true } },
        vendor: { select: { name: true } },
      },
      orderBy: [{ entry: { date: "asc" } }, { entry: { entryNumber: "asc" } }, { lineNumber: "asc" }],
    }),
  ]);

  const debitNormal = normalBalance(account.type) === "DEBIT";
  const openingNet = money(openingSums._sum.debit ?? 0).minus(money(openingSums._sum.credit ?? 0));
  const opening = debitNormal ? openingNet : openingNet.negated();

  let running = opening;
  const rows: LedgerLine[] = lines.map((line) => {
    const movement = debitNormal
      ? money(line.debit).minus(money(line.credit))
      : money(line.credit).minus(money(line.debit));
    running = running.plus(movement);
    return {
      lineId: line.id,
      entryId: line.entry.id,
      entryNumber: line.entry.entryNumber,
      date: line.entry.date,
      memo: line.entry.memo,
      description: line.description,
      sourceType: line.entry.sourceType,
      sourceId: line.entry.sourceId,
      partyName: line.customer?.name ?? line.vendor?.name ?? null,
      debit: money(line.debit),
      credit: money(line.credit),
      runningBalance: running,
    };
  });

  return {
    account,
    opening,
    rows,
    closing: running,
    totalDebit: rows.reduce<Money>((total, row) => total.plus(row.debit), money(0)),
    totalCredit: rows.reduce<Money>((total, row) => total.plus(row.credit), money(0)),
  };
}

/**
 * Where a journal entry came from, so a drilled-into line can open its source
 * document — the second half of "every figure is drillable" (SPEC §12).
 */
export function sourceDocumentHref(sourceType: string, sourceId: string | null): string | null {
  if (!sourceId) return null;
  switch (sourceType) {
    case "INVOICE":
      return `/invoices/${sourceId}`;
    case "WORK_ORDER":
      return `/work-orders/${sourceId}`;
    case "INVOICE_PAYMENT":
      return `/payments`;
    case "EXPENSE":
      return `/expenses`;
    default:
      return null;
  }
}

export function sourceLabel(sourceType: string): string {
  return sourceType.toLowerCase().replace(/_/g, " ");
}
