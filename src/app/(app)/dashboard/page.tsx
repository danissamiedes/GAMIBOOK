import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { withFinancialScope } from "@/lib/company-scope";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { prisma } from "@/lib/db";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { MONTHS } from "@/lib/currency";

/**
 * Phase 1 placeholder. The real dashboard (cash, A/R, A/P, unmatched bank
 * lines, who is clocked in) is Phase 9 — its tiles depend on phases that do
 * not exist yet (SPEC §12).
 */
export default async function DashboardPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  const scope = await withFinancialScope(userId, companyId);

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const memberCount = await prisma.membership.count({ where: scope.where });

  return (
    <>
      <PageHeader
        title={company.name}
        description={`Books in ${company.baseCurrency} · fiscal year starts ${
          MONTHS[company.fiscalYearStartMonth - 1]
        } · time clock in ${company.timeClockTimeZone}`}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Base currency</p>
          <p className="mt-1 text-2xl font-semibold">{company.baseCurrency}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">People with access</p>
          <p className="mt-1 text-2xl font-semibold">{memberCount}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Books closed through</p>
          <p className="mt-1 text-2xl font-semibold">
            {company.booksClosedThrough
              ? company.booksClosedThrough.toISOString().slice(0, 10)
              : "—"}
          </p>
        </Card>
      </div>
      <div className="mt-6">
        <EmptyState title="No financial data yet">
          The ledger arrives in Phase 2. Cash balances, A/R and A/P, unmatched bank lines and who is
          clocked in appear here in Phase 9.
        </EmptyState>
      </div>
    </>
  );
}
