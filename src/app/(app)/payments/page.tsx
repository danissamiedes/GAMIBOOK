import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import {
  Alert,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";
import { deletePayment, whyNotDeletablePayment } from "@/lib/invoices/payments";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui";

export const metadata = { title: pageTitle("Customer payments") };

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    saved?: string;
    error?: string;
    delete?: string;
    deleted?: string;
  }>;
}) {
  const scope = await sectionScope("SALES");

  const params = await searchParams;
  const page = readPage(params);
  const total = await prisma.payment.count({ where: scope.where });
  const summary = pageSummary(page, total, "payment");

  const payments = await prisma.payment.findMany({
    where: scope.where,
    include: {
      customer: { select: { name: true } },
      applications: {
        include: { invoice: { select: { id: true, invoiceNumber: true } } },
      },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { booksClosedThrough: true },
  });

  /*
   * Deletability for the whole page, worked out with the same rule the delete
   * enforces so the button and the action never disagree. Two queries for the
   * page rather than two per row.
   */
  const liveIds = payments.filter((payment) => !payment.reversedAt).map((payment) => payment.id);
  const [postings, bankMatches] = await Promise.all([
    liveIds.length
      ? prisma.journalEntry.findMany({
          where: {
            ...scope.where,
            sourceType: "INVOICE_PAYMENT" as const,
            sourceId: { in: liveIds },
          },
          select: {
            id: true,
            sourceId: true,
            postedAt: true,
            date: true,
            createdByUserId: true,
            reversedByEntryId: true,
          },
        })
      : [],
    liveIds.length
      ? prisma.bankTransaction.findMany({
          where: { ...scope.where, matchedPaymentId: { in: liveIds } },
          select: { matchedPaymentId: true },
        })
      : [],
  ]);

  // A payment with two postings is not deletable and the map keeps only one,
  // so count them separately and let the count decide.
  const postingCount = new Map<string, number>();
  for (const posting of postings) {
    postingCount.set(posting.sourceId!, (postingCount.get(posting.sourceId!) ?? 0) + 1);
  }
  const postingBySource = new Map(postings.map((posting) => [posting.sourceId!, posting]));
  const matchCount = new Map<string, number>();
  for (const match of bankMatches) {
    matchCount.set(match.matchedPaymentId!, (matchCount.get(match.matchedPaymentId!) ?? 0) + 1);
  }

  function deleteRefusal(payment: (typeof payments)[number]): string | null {
    return whyNotDeletablePayment({
      payment,
      entry: postingBySource.get(payment.id) ?? null,
      postings: postingCount.get(payment.id) ?? 0,
      bankMatchCount: matchCount.get(payment.id) ?? 0,
      booksClosedThrough: company.booksClosedThrough,
    });
  }

  // The row named by ?delete=, and only if it is genuinely deletable: a stale
  // link or a guessed id gets no confirmation screen.
  const pendingDelete = params.delete
    ? (payments.find(
        (payment) => payment.id === params.delete && deleteRefusal(payment) === null,
      ) ?? null)
    : null;

  async function remove(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const paymentId = String(formData.get("paymentId"));
    try {
      // The service re-checks every rule; this form is not the guard.
      await deletePayment({ companyId: inner.companyId, paymentId, userId: inner.userId });
    } catch (caught) {
      if (caught instanceof PostingError) failTo("/payments", caught.message);
      throw caught;
    }
    redirect("/payments?deleted=1");
  }

  return (
    <>
      <PageHeader
        title="Customer payments"
        description="Money in. Reversal deletes nothing."
      />
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? (
        <Alert tone="success">
          Saved. The original entry was reversed and the corrected one posted in
          its place.
        </Alert>
      ) : null}
      {params.deleted ? (
        <Alert tone="success">
          Payment deleted. What it was is kept in the audit trail, and its journal entry number
          stays unused.
        </Alert>
      ) : null}

      {pendingDelete ? (
        <Card className="mb-4">
          <h2 className="mb-2 text-sm font-semibold text-red-700 dark:text-red-300">
            Delete this payment for good?
          </h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            {formatMoney(pendingDelete.amount.toFixed(2), pendingDelete.currency)} from{" "}
            {pendingDelete.customer.name} on {formatAccountingDate(pendingDelete.date)}, and its
            journal entry, will be removed as if the payment had never been recorded.{" "}
            {pendingDelete.applications.length === 1
              ? "The invoice it settled goes back to unpaid."
              : pendingDelete.applications.length > 1
                ? `The ${pendingDelete.applications.length} invoices it settled go back to unpaid.`
                : ""}{" "}
            Only the audit trail will remember it. To keep the correction on the record instead,
            reverse it.
          </p>
          <div className="flex items-center gap-2">
            <form action={remove}>
              <input type="hidden" name="paymentId" value={pendingDelete.id} />
              <Button variant="danger" type="submit">
                Delete permanently
              </Button>
            </form>
            <Link
              href="/payments"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </Link>
          </div>
        </Card>
      ) : null}

      {payments.length === 0 ? (
        <EmptyState
          title="No payments recorded yet"
          action={{ href: "/invoices", label: "Go to invoices" }}
        >
          Record one from an open invoice.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date</th>
                <th className="py-2">Customer</th>
                <th className="py-2">Applied to</th>
                <th className="py-2">Method</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2 text-right">Unapplied</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const applied = sum(
                  payment.applications.map((application) =>
                    money(application.amountApplied),
                  ),
                );
                const unapplied = money(payment.amount).minus(applied);
                return (
                  <tr
                    key={payment.id}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="py-2">
                      {formatAccountingDate(payment.date)}
                    </td>
                    <td className="py-2">
                      {payment.customer.name}
                      {payment.reversedAt ? (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-800 dark:bg-red-950 dark:text-red-200">
                          reversed
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      {payment.applications.length === 0
                        ? "—"
                        : payment.applications.map((application, index) => (
                            <span key={application.id}>
                              {index > 0 ? ", " : ""}
                              <Link
                                className="underline"
                                href={`/invoices/${application.invoice.id}`}
                              >
                                {application.invoice.invoiceNumber ?? "draft"}
                              </Link>
                            </span>
                          ))}
                    </td>
                    <td className="py-2 text-slate-500">
                      {payment.method.replace("_", " ").toLowerCase()}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(payment.amount.toFixed(2), payment.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {unapplied.isZero()
                        ? "—"
                        : formatMoney(unapplied.toFixed(2), payment.currency)}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end">
                        {payment.reversedAt ? null : (
                          <Link
                            href={`/payments/${payment.id}/edit`}
                            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            Edit
                          </Link>
                        )}
                        {deleteRefusal(payment) === null ? (
                          // A link, not a submit: deleting is irreversible, so
                          // it takes a second screen saying what will go.
                          <Link
                            href={`/payments?delete=${payment.id}`}
                            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
                          >
                            Delete
                          </Link>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/payments", params, page.page - 1)}
            nextHref={pageHref("/payments", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
