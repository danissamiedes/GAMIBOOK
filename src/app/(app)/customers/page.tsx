import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { SUPPORTED_CURRENCIES, formatMoney, isSupportedCurrency } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { PartyError, parseEmailList, updateCustomer } from "@/lib/parties";
import Link from "next/link";
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
  searchParams: Promise<{ error?: string; edit?: string; saved?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { error, edit, saved } = await searchParams;

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

  // The row named by ?edit=, if it is one this viewer can actually see.
  const editing = edit ? (customers.find((customer) => customer.id === edit) ?? null) : null;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const name = String(formData.get("name") || "").trim();
    const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
    const emails = parseEmailList(formData.get("emails"));
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

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const customerId = String(formData.get("customerId") || "");
    try {
      await updateCustomer({
        companyId: inner.companyId,
        userId: inner.userId,
        customerId,
        formData,
      });
    } catch (thrown) {
      if (thrown instanceof PartyError) {
        redirect(`/customers?edit=${customerId}&error=${thrown.problem}`);
      }
      throw thrown;
    }
    redirect("/customers?saved=1");
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
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? (
        <Alert tone="error">That customer is no longer here.</Alert>
      ) : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

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
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/customers?edit=${customer.id}`}
                            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                          >
                            Edit
                          </Link>
                          <form action={toggleActive}>
                            <input type="hidden" name="customerId" value={customer.id} />
                            <Button variant="ghost" type="submit">
                              {customer.isActive ? "Deactivate" : "Reactivate"}
                            </Button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">
            {editing ? `Edit ${editing.name}` : "Add a customer"}
          </h2>
          {editing ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Currency and terms are the defaults for the next invoice. Invoices
              already issued keep the ones they were raised with.
            </p>
          ) : null}
          {/* One form for both. The key remounts it when the row changes, so
              switching from one customer to another does not leave the first
              one's values sitting in the fields. */}
          <form
            key={editing?.id ?? "new"}
            action={editing ? save : create}
            className="space-y-4"
          >
            {editing ? (
              <input type="hidden" name="customerId" value={editing.id} />
            ) : null}
            <Field label="Name">
              <Input name="name" required defaultValue={editing?.name ?? ""} />
            </Field>
            <Field label="Invoice emails" hint="Comma separated.">
              <Input name="emails" type="text" defaultValue={editing?.emails.join(", ") ?? ""} />
            </Field>
            <Field
              label="Currency"
              hint={`Books are kept in ${company.baseCurrency}; invoices may be in another currency.`}
            >
              <Select
                name="defaultCurrency"
                defaultValue={editing?.defaultCurrency ?? company.baseCurrency}
              >
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment terms (days)">
              <Input
                name="paymentTermsDays"
                type="number"
                defaultValue={editing?.paymentTermsDays ?? 30}
                min={0}
              />
            </Field>
            <Field label="Billing address">
              <Input name="billingAddress" defaultValue={editing?.billingAddress ?? ""} />
            </Field>
            <Field label="Notes">
              <Input name="notes" defaultValue={editing?.notes ?? ""} />
            </Field>
            {editing ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.isActive}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                />
                Active
              </label>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="submit">{editing ? "Save changes" : "Add customer"}</Button>
              {editing ? (
                <Link
                  href="/customers"
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </Link>
              ) : null}
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
