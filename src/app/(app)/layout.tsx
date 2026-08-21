import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentUserId, signOut } from "@/lib/auth";
import { listUserCompanies, withCompanyScope } from "@/lib/company-scope";
import { resolveActiveCompanyId, setActiveCompany } from "@/lib/active-company";
import { CompanySwitcher } from "@/components/company-switcher";
import { Button, NavLink } from "@/components/ui";

/**
 * The accounting shell. Everything under it is OWNER/BOOKKEEPER territory:
 * middleware keeps consultant-only users out (SPEC §2), this layout re-checks
 * the role for the *active company*, and the data layer checks again per query.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");

  const companies = await listUserCompanies(userId);
  if (companies.length === 0) redirect("/no-access");

  const activeCompanyId = await resolveActiveCompanyId(userId);
  if (!activeCompanyId) redirect("/no-access");

  const scope = await withCompanyScope(userId, activeCompanyId);
  if (scope.role === "CONSULTANT") redirect("/time-clock");

  const active = companies.find((c) => c.id === activeCompanyId);
  if (active && !active.setupCompletedAt) redirect("/setup");

  async function switchCompany(companyId: string) {
    "use server";
    const uid = await currentUserId();
    if (!uid) redirect("/login");
    // Re-prove membership server-side before honouring the switch.
    await withCompanyScope(uid, companyId);
    await setActiveCompany(companyId);
  }

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="min-h-dvh">
      <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/dashboard" className="text-sm font-semibold tracking-tight">
            Ledger
          </Link>
          <CompanySwitcher
            companies={companies.map((c) => ({
              id: c.id,
              name: c.name,
              baseCurrency: c.baseCurrency,
            }))}
            activeId={activeCompanyId}
            action={switchCompany}
          />
          <nav className="flex flex-1 flex-wrap items-center gap-1">
            <NavLink href="/dashboard">Dashboard</NavLink>
            {/* Nav follows the sections this membership holds (SPEC §2.1).
                Hiding a link is not the guard — every page re-checks. */}
            {scope.hasSection("SALES") ? (
              <>
                <NavLink href="/customers">Customers</NavLink>
                <NavLink href="/invoices">Invoices</NavLink>
                <NavLink href="/payments">Payments</NavLink>
                <NavLink href="/reports/ar-aging">A/R Aging</NavLink>
              </>
            ) : null}
            {scope.hasSection("CONSULTANTS") ? (
              <>
                <NavLink href="/consultants">Consultants</NavLink>
                <NavLink href="/work-orders">Work orders</NavLink>
                <NavLink href="/timesheets">Timesheets</NavLink>
              </>
            ) : null}
            {scope.hasSection("VENDORS") ? (
              <>
                <NavLink href="/vendors">Vendors</NavLink>
                <NavLink href="/expenses">Expenses</NavLink>
              </>
            ) : null}
            {scope.hasSection("CONSULTANTS") || scope.hasSection("VENDORS") ? (
              <NavLink href="/reports/ap-aging">A/P Aging</NavLink>
            ) : null}
            {scope.hasSection("REPORTS") ? (
              <>
                <NavLink href="/reports/profit-loss">P&amp;L</NavLink>
                <NavLink href="/reports/balance-sheet">Balance Sheet</NavLink>
                <NavLink href="/reports/trial-balance">Trial Balance</NavLink>
                <NavLink href="/reports/general-ledger">General Ledger</NavLink>
                <NavLink href="/journal">Journal</NavLink>
              </>
            ) : null}
            {scope.hasSection("SETTINGS") ? (
              <>
                <NavLink href="/accounts">Accounts</NavLink>
                <NavLink href="/settings/company">Company</NavLink>
              </>
            ) : null}
            {scope.role === "OWNER" ? <NavLink href="/settings/users">Users</NavLink> : null}
          </nav>
          <form action={endSession}>
            <Button variant="ghost" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
