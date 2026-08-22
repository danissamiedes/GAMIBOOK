import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { updateSalesOrder } from "@/lib/invoices/sales-orders";
import { parseMoney } from "@/lib/money";
import { isoDate, parseAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit sales order") };

/**
 * Editing a sales order (SPEC §7.1a). The one document with no ledger
 * consequence in any state, so draft and confirmed are both freely editable
 * and there is no reversal to explain. It stops at INVOICED.
 */
export default async function EditSalesOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;

  const [company, order, customers, incomeAccounts, items] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.salesOrder.findFirst({
      where: { id, ...scope.where },
      include: { lines: { orderBy: { lineNumber: "asc" } } },
    }),
    prisma.customer.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "INCOME" },
      orderBy: { code: "asc" },
    }),
    prisma.item.findMany({ where: { ...scope.where, isActive: true }, orderBy: { name: "asc" } }),
  ]);

  if (!order) notFound();

  if (order.status === "INVOICED" || order.status === "CANCELLED") {
    return (
      <>
        <PageHeader title={`Sales order ${order.orderNumber ?? "draft"}`} />
        <Alert tone="error">
          {order.status === "INVOICED"
            ? "This order has been turned into an invoice. Edit the invoice instead."
            : "A cancelled order cannot be edited. Raise a new one instead."}
        </Alert>
        <div className="mt-4">
          <Link className="underline" href={`/sales-orders/${order.id}`}>
            Back to the order
          </Link>
        </div>
      </>
    );
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const back = `/sales-orders/${id}/edit`;

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
      await updateSalesOrder({
        companyId: inner.companyId,
        salesOrderId: id,
        customerId: String(formData.get("customerId") || "") || undefined,
        orderDate: parseAccountingDate(String(formData.get("orderDate") || "")) ?? undefined,
        expectedDate: parseAccountingDate(String(formData.get("expectedDate") || "")),
        currency: String(formData.get("currency") || "").toUpperCase() || undefined,
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? undefined,
        memo: String(formData.get("memo") || "").trim() || null,
        lines,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "sales_order.updated",
        entityType: "SalesOrder",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }

    redirect(`/sales-orders/${id}?saved=1`);
  }

  return (
    <>
      <PageHeader
        title={`Edit sales order ${order.orderNumber ?? "draft"}`}
        description="A sales order posts nothing, so changing one has no effect on the books."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="mt-4">
        <form action={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Customer">
              <Select name="customerId" defaultValue={order.customerId}>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} ({customer.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Order date">
              <Input
                type="date"
                name="orderDate"
                defaultValue={isoDate(order.orderDate)}
              />
            </Field>
            <Field label="Expected date">
              <Input
                type="date"
                name="expectedDate"
                defaultValue={order.expectedDate ? isoDate(order.expectedDate) : ""}
              />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={order.currency}>
                {[
                  ...new Set([
                    company.baseCurrency,
                    order.currency,
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
              defaultValue={order.fxRate.toString()}
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
            currency={order.currency}
            defaultAccountId={incomeAccounts[0]?.id}
            initialLines={order.lines.map((line) => ({
              itemId: line.itemId ?? "",
              description: line.description,
              quantity: line.quantity.toString(),
              rate: line.rate.toString(),
              accountId: line.incomeAccountId,
            }))}
          />

          <Field label="Memo">
            <Input name="memo" defaultValue={order.memo ?? ""} />
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit">Save changes</Button>
            <Link
              href={`/sales-orders/${order.id}`}
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
