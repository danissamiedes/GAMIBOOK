import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import Link from "next/link";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Consultants") };

/**
 * Consultants are vendors with kind = CONSULTANT (SPEC §6). The filter is in
 * the query, so a user in this section never sees a regular vendor and vice
 * versa — that is the separation the user asked for, not a hidden tab.
 */
export default async function ConsultantsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { error, saved } = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [consultants] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT" },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        workOrders: {
          where: { status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
          select: { balanceDue: true, fxRate: true },
        },
        user: { select: { email: true } },
      },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Consultants"
        description="Who you raise work orders for. Their email setup here is what the bulk send uses."
      />
      <div className="mb-4">
        <Link href="/consultants/new">
          <Button>Add New</Button>
        </Link>
      </div>
      {error === "email" ? (
        <Alert tone="error">
          A consultant set to receive emails needs an address. Untick the box, or add one.
        </Alert>
      ) : null}
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "rate" ? (
        <Alert tone="error">A default rate is a number, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? (
        <Alert tone="error">That consultant is no longer here.</Alert>
      ) : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4">
        <Card>
          {consultants.length === 0 ? (
            <EmptyState title="No consultants yet">
              Add the first one above. A default rate and the email addresses to send work
              orders to are what make the rest of the app quick.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Work orders go to</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {consultants.map((consultant) => {
                  const owed = sum(
                    consultant.workOrders.map((workOrder) =>
                      money(workOrder.balanceDue).times(money(workOrder.fxRate)),
                    ),
                  );
                  const recipients = consultant.sendEmails
                    ? [consultant.email, ...consultant.ccEmails].filter(Boolean).join(", ")
                    : null;
                  return (
                    <tr key={consultant.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">
                        <Link
                          href={`/consultants/${consultant.id}`}
                          className={`underline decoration-dotted underline-offset-2 ${
                            consultant.isActive ? "" : "text-slate-400 line-through"
                          }`}
                        >
                          {consultant.name}
                        </Link>
                        {consultant.user ? (
                          <div className="text-xs text-slate-500">
                            clocks in as {consultant.user.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 text-xs text-slate-600 dark:text-slate-400">
                        {recipients ?? <span className="text-amber-600">not emailed</span>}
                      </td>
                      <td className="py-2">{consultant.defaultCurrency}</td>
                      <td className="py-2 text-right tabular-nums">
                        {consultant.defaultRate ? consultant.defaultRate.toFixed(2) : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {owed.isZero() ? "—" : formatMoney(owed.toFixed(2), company.baseCurrency)}
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
