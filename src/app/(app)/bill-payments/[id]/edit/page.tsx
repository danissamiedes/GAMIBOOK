import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { withSectionScope } from "@/lib/company-scope";
import { writeAudit } from "@/lib/audit";
import { updateBillPayment } from "@/lib/payables/bill-payments";
import { money, parseMoney, sum } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { PaymentLines } from "@/components/payment-lines";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit bill payment") };

/**
 * Editing a bill payment.
 *
 * The awkward part is which documents to offer. The ones this payment already
 * settles are no longer open, so the list the recording screen uses would not
 * include them — and a payment you cannot see the lines of is not editable in
 * any useful sense. So the list here is the union: what this payment settles,
 * with its own amount added back to the balance it is holding down, plus
 * whatever else the vendor still owes on.
 */
export default async function EditBillPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const scope = await companyScope();
  scope.requireRole("OWNER", "BOOKKEEPER");
  const { error } = await searchParams;

  const payment = await prisma.billPayment.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: { select: { id: true, name: true, kind: true } },
      applications: {
        include: {
          workOrder: { select: { id: true, workOrderNumber: true, balanceDue: true, currency: true, dueDate: true } },
          expense: { select: { id: true, description: true, balanceDue: true, currency: true, dueDate: true, date: true } },
        },
      },
    },
  });
  if (!payment) notFound();

  const section = payment.vendor.kind === "CONSULTANT" ? "CONSULTANTS" : "VENDORS";
  if (!scope.hasSection(section)) redirect(`/no-access?section=${section}`);

  const [paymentAccounts, openWorkOrders, openBills, matched] = await Promise.all([
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    prisma.workOrder.findMany({
      where: {
        ...scope.where,
        vendorId: payment.vendorId,
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      },
      orderBy: { dueDate: "asc" },
    }),
    prisma.expense.findMany({
      where: {
        ...scope.where,
        vendorId: payment.vendorId,
        kind: "BILL",
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
      },
      orderBy: { date: "asc" },
    }),
    prisma.bankTransaction.count({
      where: { ...scope.where, matchedBillPaymentId: payment.id },
    }),
  ]);

  if (payment.reversedAt || matched > 0) {
    return (
      <>
        <PageHeader title={`Payment to ${payment.vendor.name}`} />
        <Alert tone="error">
          {payment.reversedAt
            ? "This payment has been reversed. Record a new one instead."
            : "A bank line is matched to this payment. Unmatch it first, then edit it."}
        </Alert>
        <div className="mt-4">
          <Link className="underline" href="/bill-payments">
            Back to bill payments
          </Link>
        </div>
      </>
    );
  }

  // What this payment is currently holding down, plus what is still open. The
  // applied amount goes back onto the balance because that is the balance the
  // document would have if this payment were not there — which is exactly what
  // the service will measure the new amount against.
  const settled = payment.applications.map((application) => {
    const workOrder = application.workOrder;
    const expense = application.expense;
    const applied = money(application.amountApplied);
    return workOrder
      ? {
          key: `apply-workOrder-${workOrder.id}`,
          id: workOrder.id,
          label: `Work order ${workOrder.workOrderNumber ?? "draft"}`,
          dueDate: workOrder.dueDate,
          currency: workOrder.currency,
          available: money(workOrder.balanceDue).plus(applied),
          applied,
        }
      : {
          key: `apply-expense-${expense!.id}`,
          id: expense!.id,
          label: expense!.description,
          dueDate: expense!.dueDate ?? expense!.date,
          currency: expense!.currency,
          available: money(expense!.balanceDue).plus(applied),
          applied,
        };
  });

  const settledIds = new Set(settled.map((line) => line.id));
  const alsoOpen = [
    ...openWorkOrders
      .filter((workOrder) => !settledIds.has(workOrder.id))
      .map((workOrder) => ({
        key: `apply-workOrder-${workOrder.id}`,
        id: workOrder.id,
        label: `Work order ${workOrder.workOrderNumber ?? "draft"}`,
        dueDate: workOrder.dueDate,
        currency: workOrder.currency,
        available: money(workOrder.balanceDue),
        applied: money(0),
      })),
    ...openBills
      .filter((bill) => !settledIds.has(bill.id))
      .map((bill) => ({
        key: `apply-expense-${bill.id}`,
        id: bill.id,
        label: bill.description,
        dueDate: bill.dueDate ?? bill.date,
        currency: bill.currency,
        available: money(bill.balanceDue),
        applied: money(0),
      })),
  ].filter((line) => line.available.greaterThan(0));

  const lines = [...settled, ...alsoOpen].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );

  async function save(formData: FormData) {
    "use server";
    const inner = await withSectionScope(scope.userId, scope.companyId, section);
    const back = `/bill-payments/${id}/edit`;

    const applications: { workOrderId?: string; expenseId?: string; amountApplied: string }[] = [];
    for (const [field, value] of formData.entries()) {
      const match = /^apply-(workOrder|expense)-(.+)$/.exec(field);
      if (!match) continue;
      const amount = parseMoney(String(value));
      if (!amount || amount.lessThanOrEqualTo(0)) continue;
      applications.push(
        match[1] === "workOrder"
          ? { workOrderId: match[2], amountApplied: amount.toFixed(2) }
          : { expenseId: match[2], amountApplied: amount.toFixed(2) },
      );
    }
    if (applications.length === 0) {
      failTo(back, "Enter an amount against at least one document");
    }

    // The payment is the sum of what it settles, same as when recording one.
    const total = sum(applications.map((application) => money(application.amountApplied)));

    try {
      await updateBillPayment({
        companyId: inner.companyId,
        billPaymentId: id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? new Date(),
        amount: total.toFixed(2),
        currency: String(formData.get("currency") || ""),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        paymentAccountId: String(formData.get("paymentAccountId")),
        reference: String(formData.get("reference") || "").trim() || null,
        notes: String(formData.get("notes") || "").trim() || null,
        applications,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "billPayment.updated",
        entityType: "BillPayment",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }

    redirect("/bill-payments?saved=1");
  }

  return (
    <>
      <PageHeader
        title={`Edit payment to ${payment.vendor.name}`}
        description="Saving reverses the original entry and posts the corrected one, dated to the original so the month it belongs to stays right."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="mt-4">
        <form action={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Date">
              <Input type="date" name="date" defaultValue={formatAccountingDate(payment.date)} />
            </Field>
            <Field label="Paid from">
              <Select name="paymentAccountId" defaultValue={payment.paymentAccountId}>
                {paymentAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference">
              <Input name="reference" defaultValue={payment.reference ?? ""} />
            </Field>
          </div>

          <input type="hidden" name="currency" value={payment.currency} />
          <input type="hidden" name="fxRate" value={payment.fxRate.toString()} />

          <PaymentLines
            currency={payment.currency}
            lines={lines.map((line) => ({
              name: line.key,
              label: line.label,
              dueLabel: `due ${formatAccountingDate(line.dueDate)}`,
              owing: line.available.toFixed(2),
              currency: line.currency,
              defaultAmount: line.applied.greaterThan(0) ? line.applied.toFixed(2) : "",
            }))}
          />

          <Field label="Notes">
            <Input name="notes" defaultValue={payment.notes ?? ""} />
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit">Save changes</Button>
            <Link
              href="/bill-payments"
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
