import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: "Journal — Ledger" };

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
  });

  const params = await searchParams;
  const page = readPage(params);
  const total = await prisma.journalEntry.count({ where: scope.where });
  const summary = pageSummary(page, total, "entry", "entries");

  const entries = await prisma.journalEntry.findMany({
    where: scope.where,
    orderBy: [{ date: "desc" }, { entryNumber: "desc" }],
    skip: page.skip,
    take: page.take,
    include: { lines: { select: { debit: true } } },
  });

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Journal"
          description="Every posting, newest first."
        />
        <Link href="/journal/new">
          <Button>New entry</Button>
        </Link>
      </div>

      {entries.length === 0 ? (
        <EmptyState title="Nothing posted yet">
          Manual entries, opening balances and — from Phase 3 — invoices and
          work orders all land here.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">No.</th>
                <th className="py-2">Date</th>
                <th className="py-2">Source</th>
                <th className="py-2">Memo</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-slate-100 dark:border-slate-800/60"
                >
                  <td className="py-2 font-mono text-xs">
                    {entry.entryNumber}
                  </td>
                  <td className="py-2">{formatAccountingDate(entry.date)}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {entry.sourceType.toLowerCase().replace(/_/g, " ")}
                  </td>
                  <td className="py-2">
                    <Link className="underline" href={`/journal/${entry.id}`}>
                      {entry.memo ?? "(no memo)"}
                    </Link>
                    {entry.reversedByEntryId ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                        reversed
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(
                      sum(entry.lines.map((line) => money(line.debit))).toFixed(
                        2,
                      ),
                      company.baseCurrency,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/journal", params, page.page - 1)}
            nextHref={pageHref("/journal", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
