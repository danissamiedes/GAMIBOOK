import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { sectionScope } from "@/lib/session-scope";
import { batchWithItems, processBatch, retryFailed } from "@/lib/email/bulk-send";
import { dryRun } from "@/lib/email/gmail";
import { PostingError } from "@/lib/errors";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, DataTable, PageHeader } from "@/components/ui";

/**
 * The result of a bulk send (SPEC §10.1): every message with its outcome, the
 * consultants who were excluded and why, and a retry that touches only what
 * failed.
 */
export default async function BulkSendResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { batchId } = await params;
  const { error } = await searchParams;

  const detail = await batchWithItems(scope.companyId, batchId);
  if (!detail) notFound();

  const { batch, items } = detail;
  const remaining = items.filter((item) => item.status === "QUEUED").length;

  async function retry() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    try {
      await retryFailed({ companyId: inner.companyId, batchId, userId: inner.userId });
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/work-orders/send/${batchId}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
    redirect(`/work-orders/send/${batchId}`);
  }

  async function resume() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    await processBatch(inner.companyId, batchId);
    redirect(`/work-orders/send/${batchId}`);
  }

  const statusTone =
    batch.status === "COMPLETED" ? "success" : batch.status === "COMPLETED_WITH_FAILURES" ? "warning" : "info";

  return (
    <>
      <PageHeader
        title="Bulk send"
        description={`${batch.sentCount} of ${batch.totalCount} sent · ${
          batch.groupByConsultant ? "one email per consultant" : "one email per work order"
        } · started ${batch.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
      />

      {error ? <Alert tone="error">{decodeURIComponent(error)}</Alert> : null}

      <Alert tone={statusTone}>
        {batch.status === "COMPLETED" ? (
          <>All {batch.sentCount} emails went out{dryRun() ? " (dry run — nothing actually sent)" : ""}.</>
        ) : batch.status === "COMPLETED_WITH_FAILURES" ? (
          <>
            {batch.sentCount} sent, <strong>{batch.failedCount} failed</strong>. Retrying re-sends
            only the failures.
          </>
        ) : remaining > 0 ? (
          <>
            {batch.sentCount} of {batch.totalCount} sent, <strong>{remaining} still to go</strong>.
            A send stops itself before the server would cut it off, so the rest are still queued —
            press Continue sending. Nothing already sent goes out twice.
          </>
        ) : (
          <>This batch is still working through its queue.</>
        )}
        {batch.skippedCount > 0 ? (
          <> {batch.skippedCount} consultant(s) were excluded — listed below with the reason.</>
        ) : null}
      </Alert>

      <div className="mt-4 flex flex-wrap gap-2">
        {batch.failedCount > 0 ? (
          <form action={retry}>
            <Button type="submit">Retry failed only</Button>
          </form>
        ) : null}
        {remaining > 0 ? (
          <form action={resume}>
            {/* Primary when it is the thing left to do: a batch that stopped
                early is unfinished work, not a footnote. */}
            <Button type="submit">Continue sending — {remaining} left</Button>
          </form>
        ) : null}
        <Link href="/work-orders/send">
          <Button variant="secondary">Back to selection</Button>
        </Link>
        <Link href={`/email-log?batch=${batch.id}`}>
          <Button variant="ghost">See the email log for this batch</Button>
        </Link>
      </div>

      <Card className="mt-6">
        <DataTable>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2">Consultant</th>
              <th className="py-2">To</th>
              <th className="py-2">Documents</th>
              <th className="py-2 text-right">Total</th>
              <th className="py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800/60">
                <td className="py-2">{item.consultantName}</td>
                <td className="py-2 text-xs">
                  {item.toAddresses.join(", ") || <span className="text-slate-400">—</span>}
                  {item.ccAddresses.length > 0 ? (
                    <div className="text-slate-500">cc {item.ccAddresses.join(", ")}</div>
                  ) : null}
                </td>
                <td className="py-2 text-xs">
                  {item.documents.map((document, index) => (
                    <span key={document!.id}>
                      {index > 0 ? ", " : ""}
                      <Link className="underline" href={`/work-orders/${document!.id}`}>
                        {document!.workOrderNumber ?? "draft"}
                      </Link>
                    </span>
                  ))}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {item.documents.length > 0
                    ? formatMoney(
                        item.documents
                          .reduce((total, document) => total + Number(document!.total), 0)
                          .toFixed(2),
                        item.documents[0]!.currency,
                      )
                    : "—"}
                </td>
                <td className="py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                      item.status === "SENT"
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                        : item.status === "FAILED"
                          ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
                          : item.status === "SKIPPED"
                            ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                            : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {item.status.toLowerCase()}
                  </span>
                  {item.reason ? (
                    <div className="mt-1 max-w-sm text-xs text-slate-600 dark:text-slate-400">
                      {item.reason}
                    </div>
                  ) : null}
                  {item.attempts > 1 ? (
                    <div className="text-xs text-slate-400">{item.attempts} attempts</div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Card>
    </>
  );
}
