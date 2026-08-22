import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { computeSalesOrderLine, confirmSalesOrder } from "@/lib/invoices/sales-orders";
import { parseMoney, sum } from "@/lib/money";
import { isoDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("New sales order") };

export default async function NewSalesOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
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
        <PageHeader title="New sales order" />
        <EmptyState title="Not quite ready">
          You need at least one customer and one income account first.
        </EmptyState>
      </>
    );
  }

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const alsoConfirm = String(formData.get("intent")) === "confirm";

    const customerId = String(formData.get("customerId") || "");
    const customer = await prisma.customer.findFirst({ where: { id: customerId, ...inner.where } });
    if (!customer) redirect("/sales-orders/new?error=customer");

    const orderDate = parseAccountingDate(String(formData.get("orderDate") || "")) ?? today();
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
        amount: computeSalesOrderLine({ quantity, rate }),
        incomeAccountId: accountId,
      });
    }
    if (lines.length === 0) redirect("/sales-orders/new?error=lines");

    const order = await prisma.salesOrder.create({
      data: {
        companyId: inner.companyId,
        customerId: customer.id,
        orderDate,
        expectedDate: parseAccountingDate(String(formData.get("expectedDate") || "")),
        currency: String(formData.get("currency") || customer.defaultCurrency).toUpperCase(),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        memo: String(formData.get("memo") || "").trim() || null,
        total: sum(lines.map((line) => line.amount)),
        lines: { create: lines },
      },
    });

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "sales_order.created",
      entityType: "SalesOrder",
      entityId: order.id,
      summary: `Draft for ${customer.name}`,
    });

    if (alsoConfirm) {
      try {
        await confirmSalesOrder({ companyId: inner.companyId, salesOrderId: order.id });
      } catch (thrown) {
        if (thrown instanceof PostingError) {
          redirect(`/sales-orders/${order.id}?error=${encodeURIComponent(thrown.message)}`);
        }
        throw thrown;
      }
    }
    redirect(`/sales-orders/${order.id}`);
  }

  return (
    <>
      <PageHeader
        title="New sales order"
        description="Records what was agreed. Confirming allocates a number; it still posts nothing."
      />
      {params.error === "lines" ? (
        <Alert tone="error">Add at least one line with a description, quantity and rate.</Alert>
      ) : null}

      <Card className="mt-4">
        <form action={create} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Customer">
              <Select name="customerId" defaultValue={customers[0].id}>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} ({customer.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Order date">
              <Input type="date" name="orderDate" defaultValue={isoDate(today())} />
            </Field>
            <Field label="Expected date">
              <Input type="date" name="expectedDate" />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={customers[0].defaultCurrency}>
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

          <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
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
            currency={customers[0].defaultCurrency}
            defaultAccountId={incomeAccounts[0]?.id}
          />

          <Field label="Memo">
            <Input name="memo" />
          </Field>

          <div className="flex gap-2">
            <Button type="submit" name="intent" value="confirm">
              Confirm order
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
