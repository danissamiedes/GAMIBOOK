import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import { reverseReclassification } from "@/lib/ledger/reclassify";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
import { Alert, Button, Card, DataTable, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Reclassification") };

/**
 * One batch, line by line: what was moved, by which entry, and back by which
 * (SPEC §18).
 *
 * Every row here is a pair of postings that still exist — the original, which
 * was never touched, and the entry that answered it. That is what makes the
 * correction auditable rather than merely done.
 */
export default async function ReclassificationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;
  const { error } = await searchParams;

  const batch = await prisma.reclassification.findFirst({
    where: { id, companyId: scope.companyId },
    include: {
      fromAccount: { select: { code: true, name: true } },
      toAccount: { select: { code: true, name: true } },
      createdBy: { select: { name: true, email: true } },
      reversedBy: { select: { name: true, email: true } },
      lines: {
        include: {
          sourceJournalLine: {
            select: {
              description: true,
              entry: { select: { id: true, entryNumber: true, date: true, sourceType: true } },
            },
          },
          journalEntry: { select: { id: true, entryNumber: true, date: true } },
          reversalEntry: { select: { id: true, entryNumber: true } },
        },
      },
    },
  });
  if (!batch) notFound();

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { baseCurrency: true },
  });

  const total = batch.lines.reduce(
    (running, line) => running.plus(money(line.debit)).plus(money(line.credit)),
    money(0),
  );

  async function reverse() {
    "use server";
    const inner = await sectionScope("REPORTS");
    try {
      await reverseReclassification({
        companyId: inner.companyId,
        reclassificationId: id,
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/reclassify/${id}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
    redirect(`/reclassify/${id}`);
  }

  return (
    <>
      <PageHeader
        title={`${batch.fromAccount.code} ${batch.fromAccount.name} → ${batch.toAccount.code} ${batch.toAccount.name}`}
        description={`${batch.lines.length} postings moved on ${formatAccountingDate(
          batch.createdAt,
        )} by ${batch.createdBy?.name ?? batch.createdBy?.email ?? "someone no longer on file"}${
          batch.reason ? ` — ${batch.reason}` : ""
        }`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {batch.reversedAt ? (
        <Alert tone="warning">
          Reversed on {formatAccountingDate(batch.reversedAt)} by{" "}
          {batch.reversedBy?.name ?? batch.reversedBy?.email ?? "someone no longer on file"}. Each
          entry below was answered by a reversing entry; the postings are back where they were.
        </Alert>
      ) : null}

      <div className="my-4 grid gap-4 sm:grid-cols-3">
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Postings moved</p>
          <p className="text-2xl font-bold tabular-nums">{batch.lines.length}</p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total moved</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatMoney(total.toFixed(2), company.baseCurrency)}
          </p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Dated</p>
          <p className="text-sm font-medium">
            {batch.postedOnDate
              ? formatAccountingDate(batch.postedOnDate)
              : "Each posting's own date"}
          </p>
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">What moved</h2>
          {batch.reversedAt ? null : (
            <form action={reverse}>
              <Button type="submit" variant="secondary">
                Reverse this reclassification
              </Button>
            </form>
          )}
        </div>

        <DataTable>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2">Original</th>
              <th className="py-2">Date</th>
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Debit</th>
              <th className="py-2 text-right">Credit</th>
              <th className="py-2">Moved by</th>
              <th className="py-2">Reversed by</th>
            </tr>
          </thead>
          <tbody>
            {batch.lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                <td className="py-2 pr-2 text-sm">
                  <Link href={`/journal/${line.sourceJournalLine.entry.id}`} className="underline">
                    JE-{line.sourceJournalLine.entry.entryNumber}
                  </Link>
                </td>
                <td className="py-2 pr-2 whitespace-nowrap text-sm">
                  {formatAccountingDate(line.sourceJournalLine.entry.date)}
                </td>
                <td className="py-2 pr-2 text-sm">{line.sourceJournalLine.description ?? ""}</td>
                <td className="py-2 pr-2 text-right tabular-nums text-sm">
                  {money(line.debit).isZero()
                    ? "—"
                    : formatMoney(money(line.debit).toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums text-sm">
                  {money(line.credit).isZero()
                    ? "—"
                    : formatMoney(money(line.credit).toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 pr-2 text-sm">
                  <Link href={`/journal/${line.journalEntry.id}`} className="underline">
                    JE-{line.journalEntry.entryNumber}
                  </Link>
                </td>
                <td className="py-2 text-sm">
                  {line.reversalEntry ? (
                    <Link href={`/journal/${line.reversalEntry.id}`} className="underline">
                      JE-{line.reversalEntry.entryNumber}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>

      <p className="mt-4 text-sm">
        <Link href="/reclassify/history" className="underline">
          Back to the history
        </Link>
      </p>
    </>
  );
}
