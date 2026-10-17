import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import { requestReclassificationReversal } from "@/lib/ledger/reclassify";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
import { Alert, Button, Card, DataTable, PageHeader } from "@/components/ui";
import { RunPanel } from "./run-panel";

export const metadata = { title: pageTitle("Reclassification") };

/** How many rows the table shows before it stops being worth scrolling. */
const PREVIEW_ROWS = 100;

/**
 * One batch, line by line: what moved, by which entry, and back by which
 * (SPEC §18).
 *
 * It is also where a batch is run. Posting a few hundred entries does not fit
 * in one request, so the page the plan lands on is the page that works
 * through it, says how far it has got, and can pick it up again if it stops.
 */
export default async function ReclassificationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; run?: string; back?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;
  const { error, run, back } = await searchParams;

  const batch = await prisma.reclassification.findFirst({
    where: { id, companyId: scope.companyId },
    include: {
      fromAccount: { select: { code: true, name: true } },
      toAccount: { select: { code: true, name: true } },
      createdBy: { select: { name: true, email: true } },
      reversedBy: { select: { name: true, email: true } },
      lines: {
        orderBy: { id: "asc" },
        include: {
          sourceJournalLine: {
            select: {
              description: true,
              entry: { select: { id: true, entryNumber: true, date: true } },
            },
          },
          journalEntry: { select: { id: true, entryNumber: true } },
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

  const waiting = batch.lines.filter(
    (line) => !line.journalEntryId && line.activeSourceLineId !== null,
  );
  const posted = batch.lines.filter((line) => line.journalEntryId);
  const toReverse = posted.filter((line) => !line.reversalEntryId);
  const undoing = Boolean(batch.reversalRequestedAt) && !batch.reversedAt;

  const total = batch.lines.reduce(
    (running, line) => running.plus(money(line.debit)).plus(money(line.credit)),
    money(0),
  );

  async function undo() {
    "use server";
    const inner = await sectionScope("REPORTS");
    try {
      await requestReclassificationReversal({
        companyId: inner.companyId,
        reclassificationId: id,
        userId: inner.userId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/reclassify/${id}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
    redirect(`/reclassify/${id}?run=1`);
  }

  return (
    <>
      <PageHeader
        title={`${batch.fromAccount.code} ${batch.fromAccount.name} → ${batch.toAccount.code} ${batch.toAccount.name}`}
        description={`${batch.lines.length} postings · ${formatAccountingDate(
          batch.createdAt,
        )} · ${batch.createdBy?.name ?? batch.createdBy?.email ?? "someone no longer on file"}${
          batch.reason ? ` — ${batch.reason}` : ""
        }`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {batch.reversedAt ? (
        <Alert tone="warning">
          Undone on {formatAccountingDate(batch.reversedAt)} by{" "}
          {batch.reversedBy?.name ?? batch.reversedBy?.email ?? "someone no longer on file"}. Each
          entry below was answered by a reversing entry; the postings are back where they were.
        </Alert>
      ) : null}

      {!batch.reversedAt && batch.completedAt && waiting.length === 0 ? (
        <Alert tone="success">
          All {posted.length} postings moved. The ledger shows them in{" "}
          {batch.toAccount.code} {batch.toAccount.name}; the original postings are untouched.
        </Alert>
      ) : null}

      {!batch.reversedAt && !undoing && waiting.length > 0 ? (
        <Card className="my-4">
          <h2 className="mb-1 text-sm font-semibold">
            {posted.length > 0 ? "This batch is part-posted" : "Ready to post"}
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            {posted.length > 0
              ? `${posted.length} of ${batch.lines.length} entries are already posted. The rest are reserved and waiting.`
              : `${waiting.length} entries to post, in batches, so none of them is cut short.`}
          </p>
          <RunPanel batchId={batch.id} mode="post" planned={waiting.length} autoStart={run === "1"} />
        </Card>
      ) : null}

      {undoing && toReverse.length > 0 ? (
        <Card className="my-4">
          <h2 className="mb-1 text-sm font-semibold">Undoing this batch</h2>
          <p className="mb-3 text-xs text-slate-500">
            {toReverse.length} entries still to reverse. Each is answered by a reversing entry
            dated to it, and the posting it moved is released.
          </p>
          <RunPanel
            batchId={batch.id}
            mode="reverse"
            planned={toReverse.length}
            autoStart={run === "1"}
          />
        </Card>
      ) : null}

      <div className="my-4 grid gap-4 sm:grid-cols-4">
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Postings</p>
          <p className="text-2xl font-bold tabular-nums">{batch.lines.length}</p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Moved so far</p>
          <p className="text-2xl font-bold tabular-nums">{posted.length}</p>
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Total</p>
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
          <h2 className="text-sm font-semibold">
            What moved{batch.lines.length > PREVIEW_ROWS ? ` — first ${PREVIEW_ROWS}` : ""}
          </h2>
          {batch.reversedAt || undoing ? null : (
            <form action={undo}>
              <Button type="submit" variant="secondary">
                {waiting.length > 0 ? "Undo what has posted" : "Undo this reclassification"}
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
            {batch.lines.slice(0, PREVIEW_ROWS).map((line) => (
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
                  {line.journalEntry ? (
                    <Link href={`/journal/${line.journalEntry.id}`} className="underline">
                      JE-{line.journalEntry.entryNumber}
                    </Link>
                  ) : line.activeSourceLineId ? (
                    <span className="text-slate-500">waiting</span>
                  ) : (
                    <span className="text-slate-500">not moved</span>
                  )}
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

      <p className="mt-4 flex gap-4 text-sm">
        <Link href="/reclassify/history" className="underline">
          Back to the history
        </Link>
        <Link href={back ? `/reclassify?${back}` : "/reclassify"} className="underline">
          Reclassify more
        </Link>
      </p>
    </>
  );
}
