import Link from "next/link";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { batchTotal, listReclassifications } from "@/lib/ledger/reclassify";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Reclassification history") };

/** Every move that has been made, and whether it still stands (SPEC §18). */
export default async function ReclassificationHistoryPage() {
  const scope = await sectionScope("REPORTS");
  const [company, batches] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    listReclassifications(scope.companyId),
  ]);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Reclassification history"
          description="Every batch that has been moved, who moved it, and whether it was reversed."
        />
        <Link href="/reclassify">
          <Button variant="secondary">Reclassify transactions</Button>
        </Link>
      </div>

      {batches.length === 0 ? (
        <EmptyState title="Nothing has been reclassified yet">
          When postings are moved from one account to another, each batch is recorded here with
          its reason and the entries it posted.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">When</th>
                <th className="py-2">Moved</th>
                <th className="py-2">From → to</th>
                <th className="py-2">Reason</th>
                <th className="py-2">By</th>
                <th className="py-2 text-right">Total</th>
                <th className="py-2">State</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2 pr-2 whitespace-nowrap text-sm">
                    <Link href={`/reclassify/${batch.id}`} className="underline">
                      {formatAccountingDate(batch.createdAt)}
                    </Link>
                  </td>
                  <td className="py-2 pr-2 tabular-nums text-sm">{batch.lines.length}</td>
                  <td className="py-2 pr-2 text-sm">
                    {batch.fromAccount.code} {batch.fromAccount.name}
                    <span className="mx-1 text-slate-400">→</span>
                    {batch.toAccount.code} {batch.toAccount.name}
                  </td>
                  <td className="py-2 pr-2 text-sm">{batch.reason ?? "—"}</td>
                  <td className="py-2 pr-2 text-sm">
                    {batch.createdBy?.name ?? batch.createdBy?.email ?? "—"}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-sm">
                    {formatMoney(batchTotal(batch.lines).toFixed(2), company.baseCurrency)}
                  </td>
                  <td className="py-2 text-sm">
                    {batch.reversedAt ? (
                      <span className="text-amber-700 dark:text-amber-500">
                        Undone {formatAccountingDate(batch.reversedAt)}
                      </span>
                    ) : batch.reversalRequestedAt ? (
                      <span className="text-amber-700 dark:text-amber-500">Being undone</span>
                    ) : batch.completedAt ? (
                      <span className="text-emerald-700 dark:text-emerald-500">Posted</span>
                    ) : (
                      // A batch that was planned and never finished is not a
                      // failure to hide: it is work somebody can pick up.
                      <Link
                        href={`/reclassify/${batch.id}`}
                        className="text-amber-700 underline dark:text-amber-500"
                      >
                        Unfinished — continue
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </>
  );
}
