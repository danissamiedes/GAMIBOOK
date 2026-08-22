import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { SUPPORTED_CURRENCIES, formatMoney, isSupportedCurrency } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui";

export const metadata = { title: pageTitle("Customers") };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const customers = await prisma.customer.findMany({
    where: scope.where,
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: {
      invoices: {
        where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        select: { balanceDue: true, fxRate: true },
      },
    },
  });

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const name = String(formData.get("name") || "").trim();
    const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
    const emails = String(formData.get("emails") || "")
      .split(/[,;\s]+/)
      .map((email) => email.trim())
      .filter(Boolean);
    const paymentTermsDays = Number(formData.get("paymentTermsDays") || 30);

    if (!name) redirect("/customers?error=name");
    if (!isSupportedCurrency(currency)) redirect("/customers?error=currency");

    const customer = await prisma.customer.create({
      data: {
        companyId: inner.companyId,
        name,
        emails,
        defaultCurrency: currency,
        paymentTermsDays: Number.isFinite(paymentTermsDays) ? paymentTermsDays : 30,
        billingAddress: String(formData.get("billingAddress") || "").trim() || null,
        notes: String(formData.get("notes") || "").trim() || null,
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "customer.created",
      entityType: "Customer",
      entityId: customer.id,
      summary: name,
    });
    redirect("/customers");
  }

  async function toggleActive(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const id = String(formData.get("customerId") || "");
    const customer = await prisma.customer.findFirst({ where: { id, ...inner.where } });
    if (!customer) redirect("/customers");
    // Soft delete only: master data referenced by a journal line is never
    // hard-deleted (SPEC §13).
    await prisma.customer.update({
      where: { id: customer.id },
      data: { isActive: !customer.isActive },
    });
    redirect("/customers");
  }

  return (
    <>
      <PageHeader title="Customers" description="Who you invoice, and in which currency." />
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {customers.length === 0 ? (
            <EmptyState title="No customers yet">
              Add your first one on the right. A customer needs a name and an email to invoice to;
              everything else can wait.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2">Terms</th>
                  <th className="py-2 text-right">Open balance</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => {
                  const open = sum(
                    customer.invoices.map((invoice) =>
                      money(invoice.balanceDue).times(money(invoice.fxRate)),
                    ),
                  );
                  return (
                    <tr key={customer.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">
                        <span className={customer.isActive ? "" : "text-slate-400 line-through"}>
                          {customer.name}
                        </span>
                        {customer.emails.length > 0 ? (
                          <div className="text-xs text-slate-500">{customer.emails.join(", ")}</div>
                        ) : null}
                      </td>
                      <td className="py-2">{customer.defaultCurrency}</td>
                      <td className="py-2 text-slate-500">Net {customer.paymentTermsDays}</td>
                      <td className="py-2 text-right tabular-nums">
                        {open.isZero() ? "—" : formatMoney(open.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-2 text-right">
                        <form action={toggleActive}>
                          <input type="hidden" name="customerId" value={customer.id} />
                          <Button variant="ghost" type="submit">
                            {customer.isActive ? "Deactivate" : "Reactivate"}
                          </Button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Add a customer</h2>
          <form action={create} className="space-y-4">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Invoice emails" hint="Comma separated.">
              <Input name="emails" type="text" />
            </Field>
            <Field
              label="Currency"
              hint={`Books are kept in ${company.baseCurrency}; invoices may be in another currency.`}
            >
              <Select name="defaultCurrency" defaultValue={company.baseCurrency}>
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment terms (days)">
              <Input name="paymentTermsDays" type="number" defaultValue={30} min={0} />
            </Field>
            <Field label="Billing address">
              <Input name="billingAddress" />
            </Field>
            <Button type="submit">Add customer</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
