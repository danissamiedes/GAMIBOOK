import Link from "next/link";
import { failTo } from "@/lib/fail";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { issueInvoice, voidInvoice, deleteDraftInvoice } from "@/lib/invoices/service";
import { recordPayment, reversePayment } from "@/lib/invoices/payments";
import { parseMoney, money } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { prepareInvoiceEmail, sendEmail, stampEmailed } from "@/lib/email/send";
import { dryRun } from "@/lib/email/gmail";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader, Select } from "@/components/ui";

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { id } = await params;
  const { error } = await searchParams;

  const invoice = await prisma.invoice.findFirst({
    where: { id, ...scope.where },
    include: {
      customer: true,
      lines: { orderBy: { lineNumber: "asc" }, include: { taxRate: true } },
      applications: { include: { payment: true } },
    },
  });
  if (!invoice) notFound();

  const [company, depositAccounts, entries] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: {
        ...scope.where,
        isActive: true,
        subtype: { in: ["CASH", "UNDEPOSITED_FUNDS"] },
      },
      orderBy: { code: "asc" },
    }),
    prisma.journalEntry.findMany({
      where: { ...scope.where, sourceType: "INVOICE", sourceId: id },
      orderBy: { postedAt: "asc" },
      select: { id: true, entryNumber: true, date: true },
    }),
  ]);

  async function issue() {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      const result = await issueInvoice({
        companyId: inner.companyId,
        invoiceId: id,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "invoice.issued",
        entityType: "Invoice",
        entityId: id,
        summary: `Issued as ${result.invoice.invoiceNumber}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/invoices/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/invoices/${id}`);
  }

  async function discard() {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      await deleteDraftInvoice(inner.companyId, id);
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/invoices/${id}`, thrown.message);
      else throw thrown;
    }
    redirect("/invoices");
  }

  async function makeVoid(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const date = parseAccountingDate(String(formData.get("date") || "")) ?? today();
    try {
      await voidInvoice({
        companyId: inner.companyId,
        invoiceId: id,
        date,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "invoice.voided",
        entityType: "Invoice",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/invoices/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/invoices/${id}`);
  }

  async function pay(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const amount = parseMoney(String(formData.get("amount") || ""));
    const date = parseAccountingDate(String(formData.get("date") || "")) ?? today();
    const depositAccountId = String(formData.get("depositAccountId") || "");
    const fxRate = parseMoney(String(formData.get("fxRate") || "1")) ?? 1;
    if (!amount) failTo(`/invoices/${id}`, "Enter the amount received");

    try {
      const result = await recordPayment({
        companyId: inner.companyId,
        customerId: String(formData.get("customerId")),
        date,
        amount: amount!,
        currency: String(formData.get("currency")),
        fxRate,
        depositAccountId,
        method: String(formData.get("method") || "BANK_TRANSFER") as "BANK_TRANSFER",
        reference: String(formData.get("reference") || "").trim() || null,
        applications: [{ invoiceId: id, amountApplied: amount! }],
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "payment.recorded",
        entityType: "Payment",
        entityId: result.payment.id,
        summary: `${amount!.toFixed(2)} against invoice ${id}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/invoices/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/invoices/${id}`);
  }

  async function undoPayment(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    try {
      await reversePayment({
        companyId: inner.companyId,
        paymentId: String(formData.get("paymentId")),
        date: today(),
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "payment.reversed",
        entityType: "Payment",
        entityId: String(formData.get("paymentId")),
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`/invoices/${id}`, thrown.message);
      else throw thrown;
    }
    redirect(`/invoices/${id}`);
  }

  async function email() {
    "use server";
    const inner = await sectionScope("SALES");
    let prepared;
    try {
      prepared = await prepareInvoiceEmail({ companyId: inner.companyId, invoiceId: id });
    } catch (thrown) {
      if (thrown instanceof ConfigurationError) failTo(`/invoices/${id}`, thrown.message);
      throw thrown;
    }
    if (prepared.to.length === 0) {
      failTo(`/invoices/${id}`, "This customer has no email address on file");
    }
    const result = await sendEmail({
      companyId: inner.companyId,
      email: prepared,
      userId: inner.userId,
    });
    if (result.status === "SENT") {
      // Stamped only on success: a failed send must leave the document
      // showing as not sent (SPEC §10.1).
      await stampEmailed("Invoice", id, inner.companyId);
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "invoice.emailed",
        entityType: "Invoice",
        entityId: id,
        summary: prepared.to.join(", "),
      });
    } else {
      failTo(`/invoices/${id}`, result.error ?? "The email failed. See the email log.");
    }
    redirect(`/invoices/${id}`);
  }

  const isDraft = invoice.status === "DRAFT";
  const hasLivePayments = invoice.applications.some(
    (application) => !application.payment.reversedAt,
  );
  const isOpen = invoice.status === "ISSUED" || invoice.status === "PARTIALLY_PAID";
  const foreign = invoice.currency !== company.baseCurrency;

  return (
    <>
      <PageHeader
        title={invoice.invoiceNumber ? `Invoice ${invoice.invoiceNumber}` : "Draft invoice"}
        description={`${invoice.customer.name} · issued ${formatAccountingDate(
          invoice.issueDate,
        )} · due ${formatAccountingDate(invoice.dueDate)} · ${invoice.status
          .replace("_", " ")
          .toLowerCase()}`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {isDraft ? (
        <Alert tone="warning">
          This is a draft. Nothing has posted to the ledger and it has no number yet — issuing does
          both, in one transaction.
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Rate</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{line.description}</td>
                  <td className="py-2 text-right tabular-nums">{line.quantity.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">{line.rate.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(line.amount.toFixed(2), invoice.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="text-sm">
              <tr>
                <td colSpan={3} className="py-1 text-right text-slate-500">
                  Subtotal
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(invoice.subtotal.toFixed(2), invoice.currency)}
                </td>
              </tr>
              {money(invoice.taxTotal).greaterThan(0) ? (
                <tr>
                  <td colSpan={3} className="py-1 text-right text-slate-500">
                    Tax
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {formatMoney(invoice.taxTotal.toFixed(2), invoice.currency)}
                  </td>
                </tr>
              ) : null}
              <tr className="font-semibold">
                <td colSpan={3} className="py-1 text-right">
                  Total
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(invoice.total.toFixed(2), invoice.currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={3} className="py-1 text-right text-slate-500">
                  Paid
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(invoice.amountPaid.toFixed(2), invoice.currency)}
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={3} className="py-1 text-right">
                  Balance due
                </td>
                <td className="py-1 text-right tabular-nums">
                  {formatMoney(invoice.balanceDue.toFixed(2), invoice.currency)}
                </td>
              </tr>
            </tfoot>
          </DataTable>

          {foreign ? (
            <p className="mt-4 text-xs text-slate-500">
              Booked at {invoice.fxRate.toFixed(4)} {company.baseCurrency} per {invoice.currency} —{" "}
              {formatMoney(invoice.baseTotal.toFixed(2), company.baseCurrency)} in the ledger.
              Payments relieve A/R at this rate whatever rate they arrive at; the difference is
              realized FX.
            </p>
          ) : null}

          {invoice.applications.length > 0 ? (
            <>
              <h2 className="mt-6 mb-2 text-sm font-semibold">Payments</h2>
              <DataTable>
                <tbody>
                  {invoice.applications.map((application) => (
                    <tr
                      key={application.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">{formatAccountingDate(application.payment.date)}</td>
                      <td className="py-2 text-slate-500">
                        {application.payment.method.replace("_", " ").toLowerCase()}
                        {application.payment.reference ? ` · ${application.payment.reference}` : ""}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(application.amountApplied.toFixed(2), invoice.currency)}
                      </td>
                      <td className="py-2 text-right">
                        {application.payment.reversedAt ? (
                          <span className="text-xs text-slate-400">reversed</span>
                        ) : (
                          <form action={undoPayment}>
                            <input type="hidden" name="paymentId" value={application.paymentId} />
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
              <a href={`/documents/invoice/${invoice.id}?refresh=1`} target="_blank" rel="noreferrer">
                <Button variant="secondary" className="w-full" type="button">
                  Download PDF
                </Button>
              </a>
              <form action={email}>
                <Button type="submit" variant="secondary" className="w-full">
                  {invoice.lastEmailedAt ? "Resend to customer" : "Email to customer"}
                </Button>
              </form>
              <p className="text-xs text-slate-500">
                {invoice.lastEmailedAt
                  ? `Last sent ${invoice.lastEmailedAt.toISOString().slice(0, 16).replace("T", " ")} UTC.`
                  : "Not sent yet."}
                {isDraft ? " Emailing a draft posts nothing." : ""}
                {dryRun() ? " Dry run is on — nothing actually leaves this machine." : ""}
              </p>
            </div>
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Actions</h2>
            <div className="space-y-3">
              {invoice.status !== "VOID" && !hasLivePayments ? (
                <Link
                  href={`/invoices/${invoice.id}/edit`}
                  className="flex h-9 w-full items-center justify-center rounded-md border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Edit invoice
                </Link>
              ) : null}
              {isDraft ? (
                <>
                  <form action={issue}>
                    <Button type="submit" className="w-full">
                      Issue invoice
                    </Button>
                  </form>
                  <form action={discard}>
                    <Button type="submit" variant="secondary" className="w-full">
                      Discard draft
                    </Button>
                  </form>
                </>
              ) : null}
              {invoice.status !== "VOID" && !isDraft ? (
                <form action={makeVoid} className="space-y-2">
                  <Field label="Void date">
                    <Input type="date" name="date" defaultValue={formatAccountingDate(today())} />
                  </Field>
                  <Button type="submit" variant="danger" className="w-full">
                    Void invoice
                  </Button>
                </form>
              ) : null}
            </div>
          </Card>

          {isOpen ? (
            <Card tone="muted">
              <h2 className="mb-3 text-sm font-semibold">Record a payment</h2>
              <form action={pay} className="space-y-3">
                <input type="hidden" name="customerId" value={invoice.customerId} />
                <input type="hidden" name="currency" value={invoice.currency} />
                <Field label="Date">
                  <Input type="date" name="date" defaultValue={formatAccountingDate(today())} />
                </Field>
                <Field label={`Amount (${invoice.currency})`}>
                  <Input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={invoice.balanceDue.toFixed(2)}
                  />
                </Field>
                {foreign ? (
                  <Field
                    label={`Payment rate (${company.baseCurrency} per ${invoice.currency})`}
                    hint="The rate on the day the money arrived — not the invoice's rate."
                  >
                    <Input name="fxRate" inputMode="decimal" defaultValue={invoice.fxRate.toFixed(4)} />
                  </Field>
                ) : (
                  <input type="hidden" name="fxRate" value="1" />
                )}
                <Field label="Deposit to">
                  <Select name="depositAccountId" defaultValue={depositAccounts[0]?.id}>
                    {depositAccounts.map((account) => (
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
                    <option value="CHECK">Check</option>
                    <option value="CASH">Cash</option>
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
