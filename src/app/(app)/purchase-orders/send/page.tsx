import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { planBulkSend, processBatch, queueBulkSend, unfinishedBatches } from "@/lib/email/bulk-send";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";
import { FilterSelect } from "@/components/filter-select";

export const metadata = { title: pageTitle("Send purchase orders") };

/**
 * Emailing purchase orders to vendors, several at a time (SPEC §10.1, §8.1a).
 *
 * The work orders screen with vendors in place of consultants, and the same
 * engine underneath. Two things it keeps, because they are what makes bulk
 * sending safe: nothing is sent until a confirmation has shown exactly what
 * will go and to whom, and a vendor who cannot be emailed is listed with the
 * reason rather than quietly dropped.
 */
export default async function SendPurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    vendor?: string;
    emailed?: string;
    selected?: string | string[];
    group?: string;
    confirm?: string;
    error?: string;
  }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;

  const groupByVendor = params.group === "1";
  const selectedIds = Array.isArray(params.selected)
    ? params.selected
    : params.selected
      ? [params.selected]
      : [];

  const [vendors, stalled] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    unfinishedBatches(scope.companyId),
  ]);

  // Only an issued order can go out: a draft has no number on it, and the
  // vendor would be reading a document that does not exist yet.
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      ...scope.where,
      status: "ISSUED",
      ...(params.vendor && params.vendor !== "ALL" ? { vendorId: params.vendor } : {}),
      ...(params.emailed === "never" ? { lastEmailedAt: null } : {}),
      ...(params.emailed === "sent" ? { lastEmailedAt: { not: null } } : {}),
    },
    include: { vendor: { select: { id: true, name: true, email: true, sendEmails: true } } },
    orderBy: [{ vendor: { name: "asc" } }, { orderDate: "asc" }],
    take: 500,
  });

  const plan =
    params.confirm === "1" && selectedIds.length > 0
      ? await planBulkSend({
          companyId: scope.companyId,
          kind: "PURCHASE_ORDER",
          documentIds: selectedIds,
          groupByConsultant: groupByVendor,
        }).catch(() => null)
      : null;

  async function send(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const ids = formData.getAll("orderId").map(String).filter(Boolean);
    const grouped = String(formData.get("group")) === "1";

    let batchId: string;
    try {
      const queued = await queueBulkSend({
        companyId: inner.companyId,
        kind: "PURCHASE_ORDER",
        documentIds: ids,
        groupByConsultant: grouped,
        userId: inner.userId,
      });
      batchId = queued.batchId;
    } catch (error) {
      if (error instanceof PostingError) {
        redirect(`/purchase-orders/send?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    // One pass, bounded by its own budget rather than by the function being
    // killed. Whatever it does not reach stays queued, and the batch page
    // says so and offers to carry on.
    await processBatch(inner.companyId, batchId);
    redirect(`/purchase-orders/send/${batchId}`);
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Send purchase orders"
          description="Email issued orders to the vendors they are addressed to, with the PDF attached."
        />
        <Link href="/purchase-orders">
          <Button variant="ghost">All purchase orders</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      {stalled.length > 0 ? (
        <Alert tone="warning">
          {stalled.length} earlier send{stalled.length === 1 ? "" : "s"} did not finish.{" "}
          <Link href={`/purchase-orders/send/${stalled[0].batch.id}`} className="underline">
            Pick up where it stopped
          </Link>
          .
        </Alert>
      ) : null}

      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3">
          <FilterSelect
            name="vendor"
            label="Vendor"
            value={params.vendor ?? "ALL"}
            options={[
              { value: "ALL", label: "All vendors" },
              ...vendors.map((vendor) => ({ value: vendor.id, label: vendor.name })),
            ]}
          />
          <FilterSelect
            name="emailed"
            label="Emailed"
            value={params.emailed ?? "never"}
            options={[
              { value: "never", label: "Never emailed" },
              { value: "sent", label: "Already emailed" },
              { value: "any", label: "Either" },
            ]}
          />
          <Button type="submit">Apply</Button>
          <Link href="/purchase-orders/send">
            <Button type="button" variant="ghost">
              Reset
            </Button>
          </Link>
        </form>
      </Card>

      {plan ? (
        <Card className="mb-4">
          <h2 className="mb-2 text-sm font-semibold">
            About to send {plan.emailCount} email{plan.emailCount === 1 ? "" : "s"} to{" "}
            {plan.consultantCount} vendor{plan.consultantCount === 1 ? "" : "s"}
          </h2>
          {plan.excluded.length > 0 ? (
            <Alert tone="warning">
              {plan.excluded.length} cannot be emailed and will be skipped:{" "}
              {plan.excluded
                .map((recipient) => `${recipient.consultantName} (${recipient.excludedReason})`)
                .join("; ")}
            </Alert>
          ) : null}
          {plan.subjectSample ? (
            <div className="my-3 rounded-md border border-slate-200 p-3 text-sm dark:border-slate-800">
              <p className="font-medium">{plan.subjectSample}</p>
              <p className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-slate-300">
                {plan.bodySample}
              </p>
            </div>
          ) : null}
          <form action={send} className="flex flex-wrap items-center gap-2">
            {plan.sendable.flatMap((recipient) =>
              recipient.documentIds.map((id) => (
                <input key={id} type="hidden" name="orderId" value={id} />
              )),
            )}
            <input type="hidden" name="group" value={groupByVendor ? "1" : "0"} />
            <Button type="submit">Send them</Button>
            <Link
              href="/purchase-orders/send"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Back
            </Link>
          </form>
        </Card>
      ) : null}

      {orders.length === 0 ? (
        <EmptyState title="Nothing to send">
          Only issued purchase orders can be emailed. Issue one from its own page, or widen the
          filters above.
        </EmptyState>
      ) : (
        <Card>
          {/* A GET form: choosing what to send is a question, and the answer
              is a URL that can be checked before anything leaves. */}
          <form method="get" className="space-y-3">
            <input type="hidden" name="confirm" value="1" />
            {params.vendor ? <input type="hidden" name="vendor" value={params.vendor} /> : null}
            {params.emailed ? <input type="hidden" name="emailed" value={params.emailed} /> : null}

            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2" />
                  <th className="py-2">Number</th>
                  <th className="py-2">Vendor</th>
                  <th className="py-2">Ordered</th>
                  <th className="py-2 pr-4 text-right">Total</th>
                  <th className="py-2">Emailed</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        name="selected"
                        value={order.id}
                        className="size-4"
                        aria-label={`Select ${order.orderNumber ?? "draft"}`}
                        defaultChecked={selectedIds.includes(order.id)}
                      />
                    </td>
                    <td className="py-2 font-mono text-xs">
                      <Link href={`/purchase-orders/${order.id}`} className="underline">
                        {order.orderNumber}
                      </Link>
                    </td>
                    <td className="py-2">
                      {order.vendor.name}
                      {!order.vendor.email || !order.vendor.sendEmails ? (
                        <span className="block text-xs text-amber-700 dark:text-amber-500">
                          {order.vendor.sendEmails ? "no email on file" : "marked not to be emailed"}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">{formatAccountingDate(order.orderDate)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatMoney(order.total.toFixed(2), order.currency)}
                    </td>
                    <td className="py-2 text-xs text-slate-500">
                      {order.lastEmailedAt ? formatAccountingDate(order.lastEmailedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="group"
                  value="1"
                  className="size-4"
                  defaultChecked={groupByVendor}
                />
                One email per vendor, with their orders attached together
              </label>
              <Button type="submit">Review before sending</Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
