import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { ConsultantForm } from "../consultant-form";
import { PartyNotes } from "@/components/party-notes";
import { PartyTabs, PartyTransactions } from "@/components/party-transactions";
import { partyTransactionCount, partyTransactions } from "@/lib/parties/transactions";
import { parseAccountingDate, isoDate } from "@/lib/dates";
import { periodPresets } from "@/lib/reports/periods";
import { Alert, Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Consultant") };

/**
 * One consultant, under two headings: what they are, and what they have
 * billed. Work orders, their bills and what has been paid against both are
 * all on the transactions tab, which is the question somebody opens a
 * consultant to ask.
 *
 * Both sections live here rather than beside the list, because editing somebody
 * on a screen showing everybody made it easy to type into the wrong row.
 *
 * Scoped to kind = CONSULTANT as well as to the company, so a regular vendor
 * cannot be read through this page — the sections guarding the two differ.
 */
export default async function ConsultantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    tab?: string;
    from?: string;
    to?: string;
    saved?: string;
    error?: string;
    note?: string;
    noteSaved?: string;
    noteError?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { id } = await params;
  const { tab, from, to, saved, error, note, noteSaved, noteError } = await searchParams;
  // Transactions is what the page opens on; Details is a deliberate click.
  const showing = tab === "details" ? "details" : "transactions";
  const period = { from: parseAccountingDate(from ?? ""), to: parseAccountingDate(to ?? "") };

  const [consultant, company, expenseAccounts] = await Promise.all([
    prisma.vendor.findFirst({
      where: { id, kind: "CONSULTANT", ...scope.where },
      include: { user: { select: { email: true } } },
    }),
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!consultant) notFound();

  // Only the open tab is paid for: the other one needs a number, not a list.
  const transactions =
    showing === "transactions"
      ? await partyTransactions({
          companyId: scope.companyId,
          vendorId: consultant.id,
          from: period.from,
          to: period.to,
        })
      : null;
  const transactionCount =
    transactions?.rows.length ?? (await partyTransactionCount(scope.companyId, consultant.id));

  return (
    <>
      <PageHeader
        title={consultant.name}
        description={`Consultant · ${consultant.defaultCurrency} · ${consultant.paymentTermsDays} day terms${
          consultant.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4">
        <Link href="/consultants">
          <Button variant="ghost">All consultants</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <PartyTabs
        base={`/consultants/${consultant.id}`}
        active={showing}
        transactionCount={transactionCount}
        label="Consultant"
      />

      {showing === "transactions" && transactions ? (
        <PartyTransactions
          rows={transactions.rows}
          totals={transactions.totals}
          truncated={transactions.truncated}
          baseCurrency={company.baseCurrency}
          base={`/consultants/${consultant.id}`}
          from={period.from ? isoDate(period.from) : ""}
          to={period.to ? isoDate(period.to) : ""}
          presets={periodPresets(company.fiscalYearStartMonth, `/consultants/${consultant.id}`, {
            tab: "transactions",
          })}
          emptyTitle="Nothing recorded against this consultant yet"
        />
      ) : (
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Main information
          </h2>
          <ConsultantForm
            editing={consultant}
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
            party={{ vendorId: consultant.id }}
            back={`/consultants/${consultant.id}?tab=details`}
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
