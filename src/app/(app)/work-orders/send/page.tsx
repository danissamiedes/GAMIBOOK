import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { planBulkSend, queueBulkSend, processBatch, MAX_BATCH_EMAILS } from "@/lib/email/bulk-send";
import { dryRun } from "@/lib/email/gmail";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Send work orders — Ledger" };

/**
 * The bulk send screen (SPEC §10.1). Filter, select, see exactly where every
 * message is going, then confirm. Nothing is sent until the confirm step, and
 * a consultant who cannot be emailed is shown greyed out with the reason
 * rather than quietly left out.
 */
export default async function BulkSendPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    consultant?: string;
    from?: string;
    to?: string;
    emailed?: string;
    batch?: string;
    group?: string;
    selected?: string | string[];
    error?: string;
    confirm?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const groupByConsultant = params.group === "1";
  const selectedIds = Array.isArray(params.selected)
    ? params.selected
    : params.selected
      ? [params.selected]
      : [];

  const [company, consultants, importBatches] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT" },
      orderBy: { name: "asc" },
    }),
    prisma.importBatch.findMany({
      where: { ...scope.where, kind: "WORK_ORDER", status: "COMMITTED" },
      orderBy: { uploadedAt: "desc" },
      take: 10,
    }),
  ]);

  const statusFilter = params.status ?? "APPROVED";
  const workOrders = await prisma.workOrder.findMany({
    where: {
      ...scope.where,
      ...(statusFilter !== "ALL"
        ? { status: statusFilter as "DRAFT" | "APPROVED" | "PARTIALLY_PAID" | "PAID" }
        : { status: { not: "VOID" } }),
      ...(params.consultant ? { vendorId: params.consultant } : {}),
      ...(params.batch ? { importBatchId: params.batch } : {}),
      ...(params.from ? { issueDate: { gte: new Date(`${params.from}T00:00:00Z`) } } : {}),
      ...(params.to ? { issueDate: { lte: new Date(`${params.to}T00:00:00Z`) } } : {}),
      // "Never emailed" is the default working filter (SPEC §10.1).
      ...(params.emailed === "never" ? { lastEmailedAt: null } : {}),
      ...(params.emailed === "sent" ? { lastEmailedAt: { not: null } } : {}),
    },
    include: { vendor: true },
    orderBy: [{ vendor: { name: "asc" } }, { issueDate: "asc" }],
    take: 500,
  });

  const plan =
    params.confirm === "1" && selectedIds.length > 0
      ? await planBulkSend({
          companyId: scope.companyId,
          workOrderIds: selectedIds,
          groupByConsultant,
        }).catch(() => null)
      : null;

  async function send(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const ids = formData.getAll("workOrderId").map(String).filter(Boolean);
    const grouped = String(formData.get("group")) === "1";

    let batchId: string;
    try {
      const queued = await queueBulkSend({
        companyId: inner.companyId,
        workOrderIds: ids,
        groupByConsultant: grouped,
        userId: inner.userId,
      });
      batchId = queued.batchId;
    } catch (error) {
      if (error instanceof PostingError) {
        redirect(`/work-orders/send?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    // Work through the queue, then land on the results. Long batches are
    // throttled, so this is deliberately the slow part of the flow.
    await processBatch(inner.companyId, batchId);
    redirect(`/work-orders/send/${batchId}`);
  }

  const query = (overrides: Record<string, string>) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries({
      status: statusFilter,
      consultant: params.consultant ?? "",
      from: params.from ?? "",
      to: params.to ?? "",
      emailed: params.emailed ?? "",
      batch: params.batch ?? "",
      group: groupByConsultant ? "1" : "",
      ...overrides,
    })) {
      if (value) next.set(key, value);
    }
    return `/work-orders/send?${next.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Send work orders"
        description="Select what to send. Each consultant gets their own documents, at the addresses on their record."
      />

      {params.error ? <Alert tone="error">{decodeURIComponent(params.error)}</Alert> : null}
      {dryRun() ? (
        <Alert tone="warning">
          <strong>Dry run is on.</strong> Everything will be composed and logged, and nothing will
          actually be sent.
        </Alert>
      ) : null}

      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="Status">
            <Select name="status" defaultValue={statusFilter}>
              <option value="APPROVED">Approved</option>
              <option value="DRAFT">Draft</option>
              <option value="PARTIALLY_PAID">Partially paid</option>
              <option value="PAID">Paid</option>
              <option value="ALL">Any</option>
            </Select>
          </Field>
          <Field label="Consultant">
            <Select name="consultant" defaultValue={params.consultant ?? ""}>
              <option value="">All</option>
              {consultants.map((consultant) => (
                <option key={consultant.id} value={consultant.id}>
                  {consultant.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Emailed">
            <Select name="emailed" defaultValue={params.emailed ?? ""}>
              <option value="">Either</option>
              <option value="never">Never emailed</option>
              <option value="sent">Already emailed</option>
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" name="from" defaultValue={params.from ?? ""} />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={params.to ?? ""} />
          </Field>
          {importBatches.length > 0 ? (
            <Field label="Import">
              <Select name="batch" defaultValue={params.batch ?? ""}>
                <option value="">Any</option>
                {importBatches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.fileName}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Button type="submit">Apply filters</Button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          <a href={query({ group: groupByConsultant ? "" : "1" })}>
            <Button variant={groupByConsultant ? "primary" : "secondary"} type="button">
              {groupByConsultant ? "One email per consultant" : "One email per work order"}
            </Button>
          </a>
          <span className="self-center text-xs text-slate-500">
            {groupByConsultant
              ? "A consultant with several selected gets one message with all their PDFs."
              : "Each work order goes out as its own message."}
          </span>
        </div>
      </Card>

      {workOrders.length === 0 ? (
        <EmptyState title="Nothing matches those filters" />
      ) : (
        <form action={send}>
          <input type="hidden" name="group" value={groupByConsultant ? "1" : "0"} />
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 w-8" />
                  <th className="py-2">Work order</th>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Goes to</th>
                  <th className="py-2">Date</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2">Last emailed</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((workOrder) => {
                  const sendable = workOrder.vendor.sendEmails && Boolean(workOrder.vendor.email);
                  const reason = !workOrder.vendor.sendEmails
                    ? "Marked not to be emailed"
                    : "No email address on file";
                  return (
                    <tr
                      key={workOrder.id}
                      className={`border-b border-slate-100 dark:border-slate-800/60 ${
                        sendable ? "" : "opacity-60"
                      }`}
                    >
                      <td className="py-2">
                        {sendable ? (
                          <input
                            type="checkbox"
                            name="workOrderId"
                            value={workOrder.id}
                            defaultChecked={selectedIds.includes(workOrder.id)}
                          />
                        ) : null}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        <Link className="underline" href={`/work-orders/${workOrder.id}`}>
                          {workOrder.workOrderNumber ?? "draft"}
                        </Link>
                        {workOrder.status === "DRAFT" ? (
                          <span className="ml-2 rounded bg-amber-100 px-1 text-[10px] uppercase text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                            not approved
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2">{workOrder.vendor.name}</td>
                      <td className="py-2 text-xs">
                        {sendable ? (
                          <>
                            {workOrder.vendor.email}
                            {workOrder.vendor.ccEmails.length > 0 ? (
                              <span className="text-slate-500">
                                {" "}
                                cc {workOrder.vendor.ccEmails.join(", ")}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-amber-700 dark:text-amber-300">{reason}</span>
                        )}
                      </td>
                      <td className="py-2">{formatAccountingDate(workOrder.issueDate)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(workOrder.total.toFixed(2), workOrder.currency)}
                      </td>
                      <td className="py-2 text-xs text-slate-500">
                        {workOrder.lastEmailedAt
                          ? workOrder.lastEmailedAt.toISOString().slice(0, 10)
                          : "never"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button type="submit" formAction={send}>
                Send selected
              </Button>
              <p className="text-xs text-slate-500">
                Up to {MAX_BATCH_EMAILS} emails per batch. Sending a draft posts nothing — it stays
                unapproved. Amounts shown in each document&apos;s own currency; books are{" "}
                {company.baseCurrency}.
              </p>
            </div>
          </Card>
        </form>
      )}

      {plan ? (
        <Card className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">
            Send {plan.emailCount} email{plan.emailCount === 1 ? "" : "s"} to {plan.consultantCount}{" "}
            consultant{plan.consultantCount === 1 ? "" : "s"} ({plan.recipientAddressCount} addresses)
          </h2>
          {plan.draftCount > 0 ? (
            <Alert tone="warning">
              {plan.draftCount} of these include work orders that are not approved. Sending them
              posts nothing, but the consultant sees a document marked DRAFT.
            </Alert>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
