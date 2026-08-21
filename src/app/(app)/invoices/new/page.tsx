import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { issueInvoice, computeLine } from "@/lib/invoices/service";
import { parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "New invoice — Ledger" };

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; customerId?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [customers, incomeAccounts, items] = await Promise.all([
    prisma.customer.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "INCOME" },
      orderBy: { code: "asc" },
    }),
    prisma.item.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  if (customers.length === 0 || incomeAccounts.length === 0) {
    return (
      <>
        <PageHeader title="New invoice" />
        <EmptyState title="Not quite ready">
          You need at least one customer and one income account before invoicing.
        </EmptyState>
      </>
    );
  }

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const alsoIssue = String(formData.get("intent")) === "issue";

    const customerId = String(formData.get("customerId") || "");
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, ...inner.where },
    });
    if (!customer) redirect("/invoices/new?error=customer");

    const issueDate = parseAccountingDate(String(formData.get("issueDate") || "")) ?? today();
    const dueDate =
      parseAccountingDate(String(formData.get("dueDate") || "")) ??
      new Date(issueDate.getTime() + customer.paymentTermsDays * 86_400_000);

    const currency = String(formData.get("currency") || customer.defaultCurrency).toUpperCase();
    const fxRate = parseMoney(String(formData.get("fxRate") || "1")) ?? undefined;

    const lineCount = Number(formData.get("lineCount") || 0);
    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const description = String(formData.get(`line-${index}-description`) || "").trim();
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      const quantity = parseMoney(String(formData.get(`line-${index}-quantity`) || ""));
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      if (!description || !accountId || !quantity || !rate) continue;

      lines.push({
        lineNumber: lines.length + 1,
        description,
        quantity,
        rate,
        amount: computeLine({ quantity, rate }),
        incomeAccountId: accountId,
      });
    }
    if (lines.length === 0) redirect("/invoices/new?error=lines");

    const invoice = await prisma.invoice.create({
      data: {
        companyId: inner.companyId,
        customerId: customer.id,
        issueDate,
        dueDate,
        currency,
        fxRate: fxRate ?? 1,
        memo: String(formData.get("memo") || "").trim() || null,
        terms: `Net ${customer.paymentTermsDays}`,
        lines: { create: lines },
      },
    });

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "invoice.created",
      entityType: "Invoice",
      entityId: invoice.id,
      summary: `Draft for ${customer.name}`,
    });

    if (alsoIssue) {
      try {
        await issueInvoice({
          companyId: inner.companyId,
          invoiceId: invoice.id,
          userId: inner.userId,
          role: inner.role,
        });
      } catch (thrown) {
        if (thrown instanceof PostingError) {
          redirect(`/invoices/${invoice.id}?error=${encodeURIComponent(thrown.message)}`);
        }
        throw thrown;
      }
    }

    redirect(`/invoices/${invoice.id}`);
  }

  const defaultCustomer = customers.find((c) => c.id === params.customerId) ?? customers[0];

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Saved as a draft. Issuing is what allocates the number and posts to the ledger."
      />
      {params.error === "lines" ? (
        <Alert tone="error">Add at least one line with a description, quantity and rate.</Alert>
      ) : null}

      <Card className="mt-4">
        <form action={create} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Customer">
              <Select name="customerId" defaultValue={defaultCustomer.id}>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} ({customer.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Issue date">
              <Input type="date" name="issueDate" defaultValue={formatAccountingDate(today())} />
            </Field>
            <Field label="Due date" hint="Defaults from the customer's terms.">
              <Input type="date" name="dueDate" />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={defaultCustomer.defaultCurrency}>
                {[...new Set([company.baseCurrency, ...customers.map((c) => c.defaultCurrency)])].map(
                  (currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ),
                )}
              </Select>
            </Field>
          </div>

          <Field
            label={`Exchange rate (${company.baseCurrency} per unit)`}
            hint={`Leave at 1 when invoicing in ${company.baseCurrency}. The receivable is later relieved at this rate, whatever the payment's rate turns out to be.`}
          >
            <Input name="fxRate" inputMode="decimal" defaultValue="1" className="max-w-xs" />
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
            currency={defaultCustomer.defaultCurrency}
            defaultAccountId={incomeAccounts[0]?.id}
          />

          <Field label="Memo">
            <Input name="memo" />
          </Field>

          <div className="flex gap-2">
            <Button type="submit" name="intent" value="issue">
              Issue invoice
            </Button>
            <Button type="submit" name="intent" value="draft" variant="secondary">
              Save as draft
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
