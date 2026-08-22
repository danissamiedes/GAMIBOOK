import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { updateInvoice } from "@/lib/invoices/service";
import { parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit invoice") };

/**
 * Editing an invoice (SPEC §7.1). A draft is changed outright; an issued one is
 * reversed and reposted, keeping its number. The service decides which — this
 * page only has to say what is about to happen.
 */
export default async function EditInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;

  const [company, invoice, customers, incomeAccounts, items] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.invoice.findFirst({
      where: { id, ...scope.where },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        applications: { include: { payment: { select: { reversedAt: true } } } },
      },
    }),
    prisma.customer.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "INCOME" },
      orderBy: { code: "asc" },
    }),
    prisma.item.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  if (!invoice) notFound();

  const paid = invoice.applications.filter((a) => !a.payment.reversedAt).length > 0;
  const posted = invoice.status !== "DRAFT";

  if (invoice.status === "VOID" || paid) {
    return (
      <>
        <PageHeader title={`Invoice ${invoice.invoiceNumber ?? "draft"}`} />
        <Alert tone="error">
          {invoice.status === "VOID"
            ? "A void invoice cannot be edited. Raise a new one instead."
            : "This invoice has payments applied. Reverse them first, then edit it."}
        </Alert>
        <div className="mt-4">
          <Link className="underline" href={`/invoices/${invoice.id}`}>
            Back to the invoice
          </Link>
        </div>
      </>
    );
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const back = `/invoices/${id}/edit`;

    const customerId = String(formData.get("customerId") || "");
    const issueDate = parseAccountingDate(String(formData.get("issueDate") || ""));
    const dueDate = parseAccountingDate(String(formData.get("dueDate") || ""));
    const currency = String(formData.get("currency") || "").toUpperCase();
    const fxRate = parseMoney(String(formData.get("fxRate") || "1")) ?? undefined;

    const lineCount = Number(formData.get("lineCount") || 0);
    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const description = String(formData.get(`line-${index}-description`) || "").trim();
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      const quantity = parseMoney(String(formData.get(`line-${index}-quantity`) || ""));
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      if (!description || !accountId || !quantity || !rate) continue;
      lines.push({ description, quantity, rate, incomeAccountId: accountId });
    }
    if (lines.length === 0) failTo(back, "Add at least one line with a description, quantity and rate.");

    try {
      await updateInvoice({
        companyId: inner.companyId,
        invoiceId: id,
        customerId: customerId || undefined,
        issueDate: issueDate ?? undefined,
        dueDate: dueDate ?? undefined,
        currency: currency || undefined,
        fxRate,
        memo: String(formData.get("memo") || "").trim() || null,
        lines,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "invoice.updated",
        entityType: "Invoice",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }

    redirect(`/invoices/${id}?saved=1`);
  }

  return (
    <>
      <PageHeader
        title={`Edit invoice ${invoice.invoiceNumber ?? "draft"}`}
        description={
          posted
            ? "This invoice has posted. Saving reverses that entry and posts the corrected one; the invoice keeps its number."
            : "A draft posts nothing, so this simply changes it."
        }
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {posted ? (
        <Alert tone="warning">
          The reversal is dated to the original posting, so the month this
          invoice belongs to stays right. If that month is closed, only an owner
          can save.
        </Alert>
      ) : null}

      <Card className="mt-4">
        <form action={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Customer">
              <Select name="customerId" defaultValue={invoice.customerId}>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} ({customer.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Issue date">
              <Input
                type="date"
                name="issueDate"
                defaultValue={formatAccountingDate(invoice.issueDate)}
              />
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                name="dueDate"
                defaultValue={formatAccountingDate(invoice.dueDate)}
              />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={invoice.currency}>
                {[
                  ...new Set([
                    company.baseCurrency,
                    invoice.currency,
                    ...customers.map((c) => c.defaultCurrency),
                  ]),
                ].map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
            <Input
              name="fxRate"
              inputMode="decimal"
              defaultValue={invoice.fxRate.toString()}
              className="max-w-xs"
            />
          </Field>

          <DocumentLineEditor
            accounts={incomeAccounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            items={items.map((item) => ({
              id: item.id,
              name: item.name,
              defaultRate: item.defaultRate ? item.defaultRate.toFixed(2) : null,
              accountId: item.incomeAccountId,
            }))}
            accountLabel="Income account"
            currency={invoice.currency}
            defaultAccountId={incomeAccounts[0]?.id}
            initialLines={invoice.lines.map((line) => ({
              itemId: line.itemId ?? "",
              description: line.description,
              quantity: line.quantity.toString(),
              rate: line.rate.toString(),
              accountId: line.incomeAccountId,
            }))}
          />

          <Field label="Memo">
            <Input name="memo" defaultValue={invoice.memo ?? ""} />
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit">Save changes</Button>
            <Link
              href={`/invoices/${invoice.id}`}
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
