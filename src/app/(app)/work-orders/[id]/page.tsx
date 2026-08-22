import Link from "next/link";
import { failTo } from "@/lib/fail";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import {
  approveWorkOrder,
  deleteDraftWorkOrder,
  voidWorkOrder,
} from "@/lib/payables/work-orders";
import { recordBillPayment, reverseBillPayment } from "@/lib/payables/bill-payments";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { PostingError } from "@/lib/errors";
import { prepareWorkOrderEmail, sendEmail, stampEmailed } from "@/lib/email/send";
import { dryRun } from "@/lib/email/gmail";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader, Select } from "@/components/ui";

export default async function WorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { id } = await params;
  const { error } = await searchParams;

  const workOrder = await prisma.workOrder.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: true,
      lines: { orderBy: { lineNumber: "asc" } },
      applications: { include: { billPayment: true } },
    },
  });
  if (!workOrder) notFound();

  const [company, accounts, paymentAccounts, entries] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({ where: scope.where, select: { id: true, code: true, name: true } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    prisma.journalEntry.findMany({
      where: { ...scope.where, sourceType: "WORK_ORDER", sourceId: id },
      orderBy: { postedAt: "asc" },
      select: { id: true, entryNumber: true },
    }),
  ]);
  const accountsById = new Map(accounts.map((account) => [account.id, account]));

  async function approve(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const approvedAt = parseAccountingDate(String(formData.get("approvedAt") || ""));
    try {
      const result = await approveWorkOrder({
        companyId: inner.companyId,
        workOrderId: id,
        approvedAt,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "work_order.approved",
        entityType: "WorkOrder",
        entityId: id,
        summary: `Approved as ${result.workOrder.workOrderNumber}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/work-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/work-orders/${id}`);
  }

  async function discard() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    try {
      await deleteDraftWorkOrder(inner.companyId, id);
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/work-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect("/work-orders");
  }

  async function makeVoid(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    try {
      await voidWorkOrder({
        companyId: inner.companyId,
        workOrderId: id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/work-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/work-orders/${id}`);
  }

  async function pay(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) failTo(`/work-orders/${id}`, "Enter the amount paid");
    try {
      await recordBillPayment({
        companyId: inner.companyId,
        vendorId: String(formData.get("vendorId")),
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        amount: amount!,
        currency: String(formData.get("currency")),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        paymentAccountId: String(formData.get("paymentAccountId")),
        method: String(formData.get("method") || "BANK_TRANSFER") as "BANK_TRANSFER",
        reference: String(formData.get("reference") || "").trim() || null,
        applications: [{ workOrderId: id, amountApplied: amount! }],
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/work-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/work-orders/${id}`);
  }

  async function undoPayment(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    try {
      await reverseBillPayment({
        companyId: inner.companyId,
        billPaymentId: String(formData.get("billPaymentId")),
        date: today(),
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/work-orders/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/work-orders/${id}`);
  }

  async function email() {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const prepared = await prepareWorkOrderEmail({
      companyId: inner.companyId,
      workOrderId: id,
    });
    if (prepared.to.length === 0) {
      failTo(`/work-orders/${id}`, prepared.excludedReason ?? "This consultant has no email address on file");
    }
    const result = await sendEmail({
      companyId: inner.companyId,
      email: prepared,
      userId: inner.userId,
    });
    if (result.status === "SENT") {
      await stampEmailed("WorkOrder", id, inner.companyId);
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "work_order.emailed",
        entityType: "WorkOrder",
        entityId: id,
        summary: prepared.to.join(", "),
      });
    } else {
      failTo(`/work-orders/${id}`, result.error ?? "The email failed. See the email log.");
    }
    redirect(`/work-orders/${id}`);
  }

  const isDraft = workOrder.status === "DRAFT";
  const isOpen = workOrder.status === "APPROVED" || workOrder.status === "PARTIALLY_PAID";
  const foreign = workOrder.currency !== company.baseCurrency;

  return (
    <>
      <PageHeader
        title={workOrder.workOrderNumber ? `Work order ${workOrder.workOrderNumber}` : "Draft work order"}
        description={`${workOrder.vendor.name} · ${formatAccountingDate(
          workOrder.issueDate,
        )} · ${workOrder.status.replace("_", " ").toLowerCase()}`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {isDraft ? (
        <Alert tone="warning">
          A draft. Nothing has posted and it has no number — approving does both, dated the work
          order date rather than today.
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Description</th>
                <th className="py-2">Account</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {workOrder.lines.map((line) => {
                const account = accountsById.get(line.accountId);
                const negative = money(line.amount).isNegative();
                return (
                  <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{line.description}</td>
                    <td className="py-2 text-xs text-slate-500">
                      {account ? `${account.code} ${account.name}` : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">{line.quantity.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums">{line.rate.toFixed(2)}</td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        negative ? "text-amber-700 dark:text-amber-300" : ""
                      }`}
                    >
                      {formatMoney(line.amount.toFixed(2), workOrder.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <td colSpan={4} className="py-2 text-right">
                  Net payable
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatMoney(workOrder.total.toFixed(2), workOrder.currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={4} className="py-1 text-right text-slate-500">
                  Paid
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(workOrder.amountPaid.toFixed(2), workOrder.currency)}
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={4} className="py-1 text-right">
                  Balance
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(workOrder.balanceDue.toFixed(2), workOrder.currency)}
                </td>
              </tr>
            </tfoot>
          </DataTable>

          {foreign ? (
            <p className="mt-4 text-xs text-slate-500">
              Booked at {workOrder.fxRate.toFixed(4)} {company.baseCurrency} per{" "}
              {workOrder.currency} —{" "}
              {formatMoney(workOrder.baseTotal.toFixed(2), company.baseCurrency)} in the ledger.
              Payments relieve A/P at this rate; the difference is realized FX.
            </p>
          ) : null}

          {workOrder.applications.length > 0 ? (
            <>
              <h2 className="mt-6 mb-2 text-sm font-semibold">Payments</h2>
              <DataTable>
                <tbody>
                  {workOrder.applications.map((application) => (
                    <tr key={application.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">{formatAccountingDate(application.billPayment.date)}</td>
                      <td className="py-2 text-slate-500">
                        {application.billPayment.method.replace("_", " ").toLowerCase()}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(application.amountApplied.toFixed(2), workOrder.currency)}
                      </td>
                      <td className="py-2 text-right">
                        {application.billPayment.reversedAt ? (
                          <span className="text-xs text-slate-400">reversed</span>
                        ) : (
                          <form action={undoPayment}>
                            <input type="hidden" name="billPaymentId" value={application.billPaymentId} />
                            <Button variant="ghost" type="submit">
                              Reverse
                            </Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </>
          ) : null}

          {entries.length > 0 ? (
            <p className="mt-4 text-xs text-slate-500">
              Posted as{" "}
              {entries.map((entry, index) => (
                <span key={entry.id}>
                  {index > 0 ? ", " : ""}
                  <Link className="underline" href={`/journal/${entry.id}`}>
                    entry {entry.entryNumber}
                  </Link>
                </span>
              ))}
              .
            </p>
          ) : null}
        </Card>

        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Document</h2>
            <div className="space-y-3">
              <a
                href={`/documents/work-order/${workOrder.id}?refresh=1`}
                target="_blank"
                rel="noreferrer"
              >
                <Button variant="secondary" className="w-full" type="button">
                  Download PDF
                </Button>
              </a>
              <form action={email}>
                <Button type="submit" variant="secondary" className="w-full">
                  {workOrder.lastEmailedAt ? "Resend to consultant" : "Email to consultant"}
                </Button>
              </form>
              <p className="text-xs text-slate-500">
                Emailing is independent of approval — sending a draft posts nothing.
                {dryRun() ? " Dry run is on; nothing actually leaves this machine." : ""}
              </p>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Actions</h2>
            {isDraft ? (
              <div className="space-y-3">
                <form action={approve} className="space-y-2">
                  <Field label="Post the A/P entry on">
                    <Input
                      type="date"
                      name="approvedAt"
                      defaultValue={formatAccountingDate(workOrder.issueDate)}
                    />
                  </Field>
                  <Button type="submit" className="w-full">
                    Approve
                  </Button>
                </form>
                <form action={discard}>
                  <Button type="submit" variant="secondary" className="w-full">
                    Discard draft
                  </Button>
                </form>
              </div>
            ) : workOrder.status !== "VOID" ? (
              <form action={makeVoid} className="space-y-2">
                <Field label="Void date">
                  <Input type="date" name="date" defaultValue={formatAccountingDate(today())} />
                </Field>
                <Button type="submit" variant="danger" className="w-full">
                  Void work order
                </Button>
              </form>
            ) : (
              <p className="text-sm text-slate-500">This work order is void.</p>
            )}
          </Card>

          {isOpen ? (
            <Card tone="muted">
              <h2 className="mb-3 text-sm font-semibold">Record a payment</h2>
              <form action={pay} className="space-y-3">
                <input type="hidden" name="vendorId" value={workOrder.vendorId} />
                <input type="hidden" name="currency" value={workOrder.currency} />
                <Field label="Date">
                  <Input type="date" name="date" defaultValue={formatAccountingDate(today())} />
                </Field>
                <Field label={`Amount (${workOrder.currency})`}>
                  <Input name="amount" inputMode="decimal" defaultValue={workOrder.balanceDue.toFixed(2)} />
                </Field>
                {foreign ? (
                  <Field label={`Payment rate (${company.baseCurrency} per ${workOrder.currency})`}>
                    <Input name="fxRate" inputMode="decimal" defaultValue={workOrder.fxRate.toFixed(4)} />
                  </Field>
                ) : (
                  <input type="hidden" name="fxRate" value="1" />
                )}
                <Field label="Paid from">
                  <Select name="paymentAccountId" defaultValue={paymentAccounts[0]?.id}>
                    {paymentAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Method">
                  <Select name="method" defaultValue="BANK_TRANSFER">
                    <option value="BANK_TRANSFER">Bank transfer</option>
                    <option value="WISE">Wise</option>
                    <option value="CASH">Cash</option>
                    <option value="CHECK">Check</option>
                    <option value="OTHER">Other</option>
                  </Select>
                </Field>
                <Field label="Reference">
                  <Input name="reference" />
                </Field>
                <Button type="submit" className="w-full">
                  Record payment
                </Button>
              </form>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
