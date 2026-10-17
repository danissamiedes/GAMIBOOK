import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { VendorForm } from "../vendor-form";
import { PartyNotes } from "@/components/party-notes";
import { PartyTabs, PartyTransactions } from "@/components/party-transactions";
import { partyTransactionCount, partyTransactions } from "@/lib/parties/transactions";
import { isoDate, today } from "@/lib/dates";
import { resolvePeriod } from "@/lib/reports/date-filter";
import { Alert, Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Vendor") };

/**
 * One vendor, under two headings: what they are, and what we have had from
 * them. Scoped to kind = REGULAR as well as to the company, so a consultant
 * cannot be read through this page — the sections guarding the two differ.
 *
 * The tab is in the URL rather than in the browser, so a vendor's account can
 * be linked to directly and a save comes back to the tab it was made on.
 */
export default async function VendorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    period?: string;
    from?: string;
    to?: string;
    saved?: string;
    error?: string;
    note?: string;
    noteSaved?: string;
    noteError?: string;
  }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { id } = await params;
  const query = await searchParams;
  const { tab, saved, error, note, noteSaved, noteError } = query;
  // Transactions is what the page opens on; Details is a deliberate click.
  const showing = tab === "details" ? "details" : "transactions";

  const [vendor, company, expenseAccounts] = await Promise.all([
    prisma.vendor.findFirst({ where: { id, kind: "REGULAR", ...scope.where } }),
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!vendor) notFound();

  // Resolved here rather than above, because the named periods are the
  // company's financial year and that is only known once it is loaded.
  const period = resolvePeriod(query, today(), company.fiscalYearStartMonth);

  // Only the open tab is paid for: the other one needs a number, not a list.
  const transactions =
    showing === "transactions"
      ? await partyTransactions({
          companyId: scope.companyId,
          vendorId: vendor.id,
          from: period.from,
          to: period.to,
        })
      : null;
  const transactionCount =
    transactions?.rows.length ?? (await partyTransactionCount(scope.companyId, vendor.id));

  return (
    <>
      <PageHeader
        title={vendor.name}
        description={`Vendor · ${vendor.defaultCurrency} · ${vendor.paymentTermsDays} day terms${
          vendor.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/vendors">
          <Button variant="ghost">All vendors</Button>
        </Link>
        <Link href={`/vendor-credits/new?party=vendor&vendor=${vendor.id}`}>
          <Button variant="ghost">Record a credit note</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <PartyTabs
        base={`/vendors/${vendor.id}`}
        active={showing}
        transactionCount={transactionCount}
        label="Vendor"
      />

      {showing === "transactions" && transactions ? (
        <PartyTransactions
          rows={transactions.rows}
          totals={transactions.totals}
          truncated={transactions.truncated}
          baseCurrency={company.baseCurrency}
          base={`/vendors/${vendor.id}`}
          from={period.from ? isoDate(period.from) : ""}
          to={period.to ? isoDate(period.to) : ""}
          periodKey={period.key}
          emptyTitle="Nothing recorded against this vendor yet"
        />
      ) : (
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Main information
          </h2>
          <VendorForm
            editing={vendor}
            baseCurrency={company.baseCurrency}
            expenseAccounts={expenseAccounts}
            error={error}
          />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Notes
          </h2>
          <PartyNotes
            scope={scope}
            party={{ vendorId: vendor.id }}
            back={`/vendors/${vendor.id}?tab=details`}
            timeZone={company.operatingTimeZone}
            openNoteId={note}
            saved={noteSaved === "1"}
            error={noteError}
          />
        </section>
      </div>
      )}
    </>
  );
}
