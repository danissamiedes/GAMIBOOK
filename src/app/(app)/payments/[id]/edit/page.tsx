import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { updatePayment } from "@/lib/invoices/payments";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, isoDate, parseAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { PaymentLines } from "@/components/payment-lines";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit payment") };

/**
 * Editing a customer payment — the mirror of the bill-payment edit screen,
 * including the same trick with the balances: an invoice this payment settles
 * gets its applied amount added back, because that is the balance the service
 * will measure a new amount against.
 */
export default async function EditPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;

  const payment = await prisma.payment.findFirst({
    where: { id, ...scope.where },
    include: {
      customer: { select: { id: true, name: true } },
      applications: {
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              balanceDue: true,
              currency: true,
              dueDate: true,
            },
          },
        },
      },
    },
  });
  if (!payment) notFound();

  const [depositAccounts, openInvoices, matched] = await Promise.all([
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    prisma.invoice.findMany({
      where: {
        ...scope.where,
        customerId: payment.customerId,
        status: { in: ["ISSUED", "PARTIALLY_PAID"] },
      },
      orderBy: { dueDate: "asc" },
    }),
    prisma.bankTransaction.count({ where: { ...scope.where, matchedPaymentId: payment.id } }),
  ]);

  if (payment.reversedAt || matched > 0) {
    return (
      <>
        <PageHeader title={`Payment from ${payment.customer.name}`} />
        <Alert tone="error">
          {payment.reversedAt
            ? "This payment has been reversed. Record a new one instead."
            : "A bank line is matched to this payment. Unmatch it first, then edit it."}
        </Alert>
        <div className="mt-4">
          <Link className="underline" href="/payments">
            Back to payments
          </Link>
        </div>
      </>
    );
  }

  const settled = payment.applications.map((application) => ({
    key: `apply-${application.invoice.id}`,
    id: application.invoice.id,
    label: `Invoice ${application.invoice.invoiceNumber ?? "draft"}`,
    dueDate: application.invoice.dueDate,
    currency: application.invoice.currency,
    available: money(application.invoice.balanceDue).plus(money(application.amountApplied)),
    applied: money(application.amountApplied),
  }));

  const settledIds = new Set(settled.map((line) => line.id));
  const alsoOpen = openInvoices
    .filter((invoice) => !settledIds.has(invoice.id))
    .filter((invoice) => money(invoice.balanceDue).greaterThan(0))
    .map((invoice) => ({
      key: `apply-${invoice.id}`,
      id: invoice.id,
      label: `Invoice ${invoice.invoiceNumber ?? "draft"}`,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      available: money(invoice.balanceDue),
      applied: money(0),
    }));

  const lines = [...settled, ...alsoOpen].sort(
    (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
  );

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const back = `/payments/${id}/edit`;

    const applications: { invoiceId: string; amountApplied: string }[] = [];
    for (const [field, value] of formData.entries()) {
      const match = /^apply-(.+)$/.exec(field);
      if (!match) continue;
      const amount = parseMoney(String(value));
      if (!amount || amount.lessThanOrEqualTo(0)) continue;
      applications.push({ invoiceId: match[1], amountApplied: amount.toFixed(2) });
    }

    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount || amount.lessThanOrEqualTo(0)) failTo(back, "Enter the amount received");

    try {
      await updatePayment({
        companyId: inner.companyId,
        paymentId: id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? new Date(),
        amount: amount!.toFixed(2),
        currency: String(formData.get("currency") || ""),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        depositAccountId: String(formData.get("depositAccountId")),
        reference: String(formData.get("reference") || "").trim() || null,
        notes: String(formData.get("notes") || "").trim() || null,
        applications,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "payment.updated",
        entityType: "Payment",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }

    redirect("/payments?saved=1");
  }

  return (
    <>
      <PageHeader
        title={`Edit payment from ${payment.customer.name}`}
        description="Saving reverses the original entry and posts the corrected one, dated to the original so the month it belongs to stays right."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="mt-4">
        <form action={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Date">
              <Input type="date" name="date" defaultValue={isoDate(payment.date)} />
            </Field>
            <Field
              label="Amount received"
              hint="Anything left unapplied stays as a credit on account."
            >
              <Input name="amount" inputMode="decimal" defaultValue={payment.amount.toFixed(2)} />
            </Field>
            <Field label="Deposited to">
              <Select name="depositAccountId" defaultValue={payment.depositAccountId}>
                {depositAccounts.map((account) => (
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
              href="/payments"
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
