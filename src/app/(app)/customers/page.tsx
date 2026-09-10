import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import Link from "next/link";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Customers") };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { error, saved } = await searchParams;

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
      <div className="mb-4">
        <Link href="/customers/new">
          <Button>Add New</Button>
        </Link>
      </div>
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? (
        <Alert tone="error">That customer is no longer here.</Alert>
      ) : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4">
        <Card>
          {customers.length === 0 ? (
            <EmptyState title="No customers yet">
              Add your first one above. A customer needs a name and an email to invoice to;
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
                        <Link
                          href={`/customers/${customer.id}`}
                          className={`underline decoration-dotted underline-offset-2 ${
                            customer.isActive ? "" : "text-slate-400 line-through"
                          }`}
                        >
                          {customer.name}
                        </Link>
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

      </div>
    </>
  );
}
