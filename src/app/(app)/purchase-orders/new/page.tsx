import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { computePurchaseOrderLine, issuePurchaseOrder } from "@/lib/payables/purchase-orders";
import { parseMoney } from "@/lib/money";
import { isoDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("New purchase order") };

/**
 * Ordering something from a vendor (SPEC §8.1a).
 *
 * The same shape as a work order, and deliberately so — but nothing here
 * posts. Issuing allocates the number and makes it sendable; the cost
 * arrives with the bill, which is made from this order when the goods do.
 */
export default async function NewPurchaseOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; vendor?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [vendors, accounts] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR", isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: {
        ...scope.where,
        isActive: true,
        // Ordering a laptop is an asset, ordering fuel is an expense, so the
        // list covers both — the same reasoning a work order's does.
        type: { in: ["EXPENSE", "ASSET"] },
      },
      orderBy: { code: "asc" },
    }),
  ]);

  if (vendors.length === 0) {
    return (
      <>
        <PageHeader title="New purchase order" />
        <EmptyState title="No vendors yet">Add a vendor before ordering from one.</EmptyState>
      </>
    );
  }

  const chosen = vendors.find((vendor) => vendor.id === params.vendor) ?? vendors[0];
  // An order is usually for something that will be a cost, so the line starts
  // on an expense account rather than on whatever sorts first — which, by
  // code, is the bank.
  const firstExpense = accounts.find((account) => account.type === "EXPENSE") ?? accounts[0];

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const alsoIssue = String(formData.get("intent")) === "issue";

    const vendorId = String(formData.get("vendorId") || "");
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, ...inner.where, kind: "REGULAR" },
    });
    if (!vendor) redirect("/purchase-orders/new?error=vendor");

    const orderDate = parseAccountingDate(String(formData.get("orderDate") || "")) ?? today();
    const expectedDate = parseAccountingDate(String(formData.get("expectedDate") || ""));
    const currency = String(formData.get("currency") || vendor!.defaultCurrency).toUpperCase();
    const fxRate = parseMoney(String(formData.get("fxRate") || "1")) ?? 1;

    const lineCount = Number(formData.get("lineCount") || 0);
    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const description = String(formData.get(`line-${index}-description`) || "").trim();
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      const quantity = parseMoney(String(formData.get(`line-${index}-quantity`) || ""));
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      if (!description || !accountId || !quantity || rate === null || rate.isZero()) continue;

      lines.push({
        lineNumber: lines.length + 1,
        description,
        quantity,
        rate,
        amount: computePurchaseOrderLine({ quantity, rate }),
        expenseAccountId: accountId,
      });
    }
    if (lines.length === 0) redirect("/purchase-orders/new?error=lines");

    const order = await prisma.purchaseOrder.create({
      data: {
        companyId: inner.companyId,
        vendorId: vendor!.id,
        orderDate,
        expectedDate,
        currency,
        fxRate,
        shipTo: String(formData.get("shipTo") || "").trim() || null,
        memo: String(formData.get("memo") || "").trim() || null,
        createdByUserId: inner.userId,
        total: lines.reduce((running, line) => running.plus(line.amount), parseMoney("0")!),
        lines: { create: lines },
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "purchase_order.created",
      entityType: "PurchaseOrder",
      entityId: order.id,
      summary: `Draft for ${vendor!.name}`,
    });

    if (alsoIssue) {
      try {
        await issuePurchaseOrder({ companyId: inner.companyId, purchaseOrderId: order.id });
      } catch (thrown) {
        if (thrown instanceof PostingError) {
          redirect(`/purchase-orders/${order.id}?error=${encodeURIComponent(thrown.message)}`);
        }
        throw thrown;
      }
    }

    redirect(`/purchase-orders/${order.id}`);
  }

  return (
    <>
      <PageHeader
        title="New purchase order"
        description="What you are ordering, from whom, and when you want it. Nothing posts until the goods arrive and you make the bill."
      />
      {params.error === "lines" ? (
        <Alert tone="error">Add at least one line with a description, quantity and price.</Alert>
      ) : null}
      {params.error === "vendor" ? <Alert tone="error">Pick a vendor.</Alert> : null}

      <Card className="mt-4">
        <form action={create} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Vendor">
              <Select name="vendorId" defaultValue={chosen.id}>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name} ({vendor.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Order date">
              <Input type="date" name="orderDate" defaultValue={isoDate(today())} />
            </Field>
            <Field label="Wanted by" hint="Printed on the order.">
              <Input type="date" name="expectedDate" />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={chosen.defaultCurrency}>
                {[...new Set([company.baseCurrency, ...vendors.map((v) => v.defaultCurrency)])].map(
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
            hint={`Leave at 1 when the order is in ${company.baseCurrency}.`}
          >
            <Input name="fxRate" inputMode="decimal" defaultValue="1" className="max-w-xs" />
          </Field>

          <DocumentLineEditor
            accounts={accounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            accountLabel="Code to"
            currency={chosen.defaultCurrency}
            defaultAccountId={chosen.defaultAccountId ?? firstExpense?.id}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Deliver to" hint="Where the vendor should send it.">
              <Input name="shipTo" />
            </Field>
            <Field label="Memo">
              <Input name="memo" />
            </Field>
          </div>

          <div className="flex gap-2">
            <Button type="submit" name="intent" value="issue">
              Issue purchase order
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
