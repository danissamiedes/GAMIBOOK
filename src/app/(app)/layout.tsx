import { APP_NAME } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentUserId, signOut } from "@/lib/auth";
import { listUserCompanies, withCompanyScope } from "@/lib/company-scope";
import { resolveActiveCompanyId, setActiveCompany } from "@/lib/active-company";
import { CompanySwitcher } from "@/components/company-switcher";
import { Button } from "@/components/ui";
import { NavMenu, type NavGroup } from "@/components/nav-menu";
import { ClosedPeriodNotice } from "@/components/closed-period-notice";
import { themeAttribute } from "@/lib/company-theme";

/**
 * The accounting shell. Everything under it is OWNER/BOOKKEEPER territory:
 * middleware keeps consultant-only users out (SPEC §2), this layout re-checks
 * the role for the *active company*, and the data layer checks again per query.
 */
/**
 * Postings run inside a database transaction whose own ceiling is 20 seconds
 * (see db.ts). The function has to outlive that, or a slow posting is killed
 * mid-write by the platform instead of rolling back cleanly on its own timeout.
 */
export const maxDuration = 60;

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

  /**
   * The nav, grouped as the business thinks of it rather than as the routes are
   * laid out. Each item keeps exactly the section check it had when these were
   * one flat row — regrouping must not widen or narrow what anyone can see.
   *
   * `only` drops the empty groups, so a bookkeeper with two sections gets two
   * menus rather than five, three of which open onto nothing.
   */
  const sales = scope.hasSection("SALES");
  const consultants = scope.hasSection("CONSULTANTS");
  const vendors = scope.hasSection("VENDORS");
  const payables = consultants || vendors;

  const groups: NavGroup[] = only([
    { label: "Dashboard", href: "/dashboard", items: [] },
    {
      label: "Customers",
      items: only([
        sales && { href: "/customers", label: "Customers" },
        sales && { href: "/sales-orders", label: "Sales orders" },
        sales && { href: "/invoices", label: "Invoices" },
        sales && { href: "/invoices/recurring", label: "Recurring" },
        sales && { href: "/payments", label: "Payments" },
        sales && { href: "/reports/sales-by-customer", label: "Sales by customer" },
        sales && { href: "/reports/ar-aging", label: "A/R Aging" },
      ]),
    },
    {
      label: "Consultants",
      items: only([
        consultants && { href: "/consultants", label: "Consultants" },
        consultants && { href: "/work-orders", label: "Work orders" },
        consultants && { href: "/work-orders/send", label: "Send" },
        consultants && { href: "/consultant-bills", label: "Consultant bills" },
        consultants && { href: "/timesheets", label: "Timesheets" },
      ]),
    },
    {
      label: "Vendors",
      items: only([
        vendors && { href: "/vendors", label: "Vendors" },
        vendors && { href: "/expenses", label: "Expenses" },
        vendors && { href: "/expenses/recurring", label: "Recurring bills" },
        // A consultant's work order and a supplier's bill are settled the same
        // way, so these belong to whoever holds either section (SPEC §6).
        payables && { href: "/bill-payments", label: "Bill payments" },
        payables && { href: "/reports/ap-aging", label: "A/P Aging" },
      ]),
    },
    {
      label: "Banking",
      items: only([
        scope.hasSection("BANKING") && { href: "/banking", label: "Banking" },
        scope.hasSection("BANKING") && { href: "/banking/match", label: "Match" },
        scope.hasSection("BANKING") && { href: "/banking/reconcile", label: "Reconcile" },
      ]),
    },
    {
      label: "Reporting",
      items: only([
        scope.hasSection("REPORTS") && { href: "/reports/profit-loss", label: "P&L" },
        scope.hasSection("REPORTS") && { href: "/reports/balance-sheet", label: "Balance Sheet" },
        scope.hasSection("REPORTS") && { href: "/reports/trial-balance", label: "Trial Balance" },
        scope.hasSection("REPORTS") && { href: "/reports/general-ledger", label: "General Ledger" },
      ]),
    },
    {
      label: "Files",
      items: only([
        // Owners only. Hiding the link is not the control — the page enforces
        // it too — but a link that leads to a refusal is worse than no link.
        scope.role === "OWNER" &&
          scope.hasSection("VENDORS") && { href: "/receipts", label: "Receipt inbox" },
      ]),
    },
    {
      label: "Other",
      items: only([
        scope.hasSection("REPORTS") && { href: "/journal", label: "Journal" },
        scope.hasSection("SETTINGS") && { href: "/accounts", label: "Accounts" },
        scope.hasSection("SETTINGS") && { href: "/settings/branding", label: "Branding" },
        scope.hasSection("SETTINGS") && { href: "/settings/email", label: "Email" },
        scope.hasSection("SETTINGS") && { href: "/settings/company", label: "Company" },
        { href: "/email-log", label: "Email log" },
        scope.role === "OWNER" && { href: "/settings/users", label: "Users" },
        // Creating one is a grant of access — the creator becomes its owner —
        // so it sits with the other owner-only entries.
        scope.role === "OWNER" && { href: "/companies/new", label: "New company" },
        // Owners only, like Users: the page refuses anyone else, and a link
        // that leads to a refusal is worse than no link.
        scope.role === "OWNER" && { href: "/close-period", label: "Close Period" },
      ]),
    },
  ]).filter((group) => group.items.length > 0 || group.href);

  return (
    // The accent for whichever company is open. It scopes the `brand` variables
    // the whole app draws from, so no component knows this happened — see the
    // per-company blocks in globals.css.
    <div className="min-h-dvh" data-company-theme={active ? themeAttribute(active.theme) : undefined}>
      {/*
        Two rows, because they answer two different questions. The top one says
        *whose books these are* — the one thing that must never be in doubt when
        the same login holds several companies, and the reason the switcher sits
        at the far right where the eye ends rather than tucked beside the brand.
        The bottom one is navigation.

        A light grey band so the chrome reads as chrome: the page below it is
        white, and the boundary is the ground changing rather than a rule doing
        all the work.
      */}
      <header className="border-b border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-6xl px-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
            <Link
              href="/dashboard"
              className="text-base font-bold tracking-tight text-brand-700 dark:text-brand-400"
            >
              {APP_NAME}
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
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 pt-1">
            {/* NavMenu carries flex-1, so Sign out lands hard right. */}
            <NavMenu groups={groups} />
            <form action={endSession}>
              <Button variant="ghost" type="submit">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* Above the page, not inside one form: every posting form in the app
            is covered, including ones added later (SPEC §4.2 rule 4). */}
        <ClosedPeriodNotice companyId={activeCompanyId} role={scope.role} />
        {children}
      </main>
    </div>
  );
}

/** Drops the `false` entries a conditional list leaves behind. */
function only<T>(entries: (T | false | null | undefined)[]): T[] {
  return entries.filter((entry): entry is T => Boolean(entry));
}
