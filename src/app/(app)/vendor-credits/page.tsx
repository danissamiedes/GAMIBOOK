import Link from "next/link";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { companyScope, sectionScope } from "@/lib/session-scope";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";
import { PARTIES, readParty, type PartyKey } from "./party";

export const metadata = { title: pageTitle("Credit notes") };

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  PARTIALLY_APPLIED: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  APPLIED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  VOID: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

/**
 * Credit notes from suppliers and consultants (SPEC §8.5).
 *
 * One screen with two tabs rather than two screens: the document, the posting
 * and the way it is applied are identical, and only who may see it differs.
 * The tab decides which section is demanded, so a bookkeeper who holds only
 * Vendors still cannot read a consultant's credit by changing the query.
 */
export default async function VendorCreditsPage({
  searchParams,
}: {
  searchParams: Promise<{ party?: string; saved?: string; voided?: string; error?: string }>;
}) {
  const params = await searchParams;
  const party = readParty(params.party);
  const config = PARTIES[party];
  const scope = await sectionScope(config.section);

  // Which tabs to offer: only the sections this person actually holds.
  const full = await companyScope();
  const tabs = (["vendor", "consultant"] as PartyKey[]).filter((key) =>
    full.hasSection(PARTIES[key].section),
  );

  const credits = await prisma.vendorCredit.findMany({
    where: { ...scope.where, vendor: { kind: config.kind } },
    include: { vendor: { select: { id: true, name: true } } },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const unused = sum(
    credits.filter((credit) => credit.status !== "VOID").map((credit) => money(credit.balance)),
  );

  return (
    <>
      <PageHeader
        title={`${config.noun} credit notes`}
        description={`Money a ${config.noun.toLowerCase()} owes back or agrees not to charge. Recording one lowers what is owed; applying it says which bill it answers.`}
      />

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Credit note recorded.</Alert> : null}
      {params.voided ? (
        <Alert tone="success">Credit note voided; its posting has been reversed.</Alert>
      ) : null}

      {tabs.length > 1 ? (
        <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {tabs.map((key) => (
            <Link
              key={key}
              href={`/vendor-credits?party=${key}`}
              aria-current={key === party ? "page" : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                key === party
                  ? "border-brand-600 text-brand-700 dark:text-brand-300"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
              }`}
            >
              {PARTIES[key].plural}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="my-4 flex flex-wrap items-center gap-2">
        <Link href={`/vendor-credits/new?party=${party}`}>
          <Button>Record a credit note</Button>
        </Link>
        <Link href={config.billsHref}>
          <Button variant="ghost">Bills</Button>
        </Link>
        {unused.greaterThan(0) ? (
          <p className="text-xs text-slate-500">
            {unused.toFixed(2)} of credit is recorded and not yet set against a bill.
          </p>
        ) : null}
      </div>

      <Card>
        {credits.length === 0 ? (
          <EmptyState
            title="No credit notes yet"
            action={{ href: `/vendor-credits/new?party=${party}`, label: "Record a credit note" }}
          >
            A credit note is a returned delivery, a line billed twice, a discount agreed after
            the invoice. Recording one debits accounts payable straight away; which bill it pays
            off is a separate, later decision.
          </EmptyState>
        ) : (
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date</th>
                <th className="py-2">Reference</th>
                <th className="py-2">{config.noun}</th>
                <th className="py-2">Memo</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2 text-right">Applied</th>
                <th className="py-2 text-right">Left</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((credit) => (
                <tr key={credit.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{formatAccountingDate(credit.date)}</td>
                  <td className="py-2 font-mono text-xs">
                    <Link className="underline" href={`/vendor-credits/${credit.id}`}>
                      {credit.reference}
                    </Link>
                  </td>
                  <td className="py-2">{credit.vendor.name}</td>
                  <td className="py-2 text-slate-500">{credit.memo ?? "—"}</td>
                  <td className="py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        STATUS_STYLES[credit.status]
                      }`}
                    >
                      {credit.status.replace("_", " ").toLowerCase()}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(credit.amount.toFixed(2), credit.currency)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(credit.amountApplied.toFixed(2), credit.currency)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(credit.balance.toFixed(2), credit.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
