import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import Link from "next/link";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Vendors") };

/** Regular vendors only (SPEC §6). Consultants live in their own section. */
export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { error, saved } = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [vendors] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR" },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        expenses: {
          where: { kind: "BILL", status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
          select: { balanceDue: true, fxRate: true },
        },
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Suppliers you receive bills from. Consultants are set up separately."
      />
      <div className="mb-4">
        <Link href="/vendors/new">
          <Button>New vendor</Button>
        </Link>
      </div>
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? <Alert tone="error">That vendor is no longer here.</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {vendors.length === 0 ? (
            <EmptyState title="No vendors yet">
              Add the first one on the right. Vendors here are the regular kind — consultants live
              on their own screen because their documents work differently.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Email</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2">Terms</th>
                  <th className="py-2 text-right">Owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => {
                  const owed = sum(
                    vendor.expenses.map((bill) => money(bill.balanceDue).times(money(bill.fxRate))),
                  );
                  return (
                    <tr key={vendor.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">
                        <Link
                          href={`/vendors/${vendor.id}`}
                          className={`underline decoration-dotted underline-offset-2 ${
                            vendor.isActive ? "" : "text-slate-400 line-through"
                          }`}
                        >
                          {vendor.name}
                        </Link>
                      </td>
                      <td className="py-2 text-slate-500">{vendor.email ?? "—"}</td>
                      <td className="py-2">{vendor.defaultCurrency}</td>
                      <td className="py-2 text-slate-500">Net {vendor.paymentTermsDays}</td>
                      <td className="py-2 text-right tabular-nums">
                        {owed.isZero() ? "—" : formatMoney(owed.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-2 text-right">
                        <Link
                          href={`/vendors/${vendor.id}`}
                          className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Edit
                        </Link>
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
