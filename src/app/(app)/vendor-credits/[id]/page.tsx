import type { Prisma } from "@prisma/client";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { failTo } from "@/lib/fail";
import { writeAudit } from "@/lib/audit";
import { PostingError } from "@/lib/errors";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  applyVendorCredit,
  openBillsForCredit,
  unapplyVendorCredit,
  voidVendorCredit,
} from "@/lib/payables/vendor-credits";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader } from "@/components/ui";
import { PARTIES, partyOf } from "../party";

export const metadata = { title: pageTitle("Credit note") };

/**
 * One credit note, on its own page (SPEC §8.5).
 *
 * Read with `companyScope` and the section checked once the credit is found,
 * for the same reason a bill is: supplier and consultant credits share a
 * table, so demanding a section before the lookup would either shut out half
 * the people entitled to read it or let the wrong half in.
 */
export default async function VendorCreditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string; applied?: string; voided?: string }>;
}) {
  const scope = await companyScope();
  const { id } = await params;
  const params_ = await searchParams;

  const credit = await prisma.vendorCredit.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: { select: { id: true, name: true, kind: true } },
      applications: {
        orderBy: { createdAt: "asc" },
        include: {
          expense: {
            select: {
              id: true,
              reference: true,
              description: true,
              date: true,
              currency: true,
              balanceDue: true,
            },
          },
        },
      },
    },
  });
  if (!credit) notFound();

  const party = partyOf(credit.vendor.kind);
  const config = PARTIES[party];
  if (!scope.hasSection(config.section)) notFound();

  const [company, account, entries, openBills] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.account.findFirst({
      where: { id: credit.expenseAccountId, companyId: scope.companyId },
      select: { code: true, name: true },
    }),
    prisma.journalEntry.findMany({
      where: { ...scope.where, sourceType: "VENDOR_CREDIT", sourceId: id },
      orderBy: { postedAt: "asc" },
      select: { id: true, entryNumber: true, reversedByEntryId: true },
    }),
    openBillsForCredit(scope.companyId, credit.vendorId),
  ]);

  const usable = openBills.filter((bill) => bill.currency === credit.currency);
  const left = money(credit.balance);
  const back = `/vendor-credits/${id}`;

  /** Set some of what is left against one or more of this party's open bills. */
  async function apply(formData: FormData) {
    "use server";
    const inner = await companyScope();
    const applications: { expenseId: string; amountApplied: Prisma.Decimal.Value }[] = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("amount_")) continue;
      const amount = parseMoney(String(value || ""));
      if (!amount || money(amount).lessThanOrEqualTo(0)) continue;
      applications.push({ expenseId: key.slice("amount_".length), amountApplied: amount });
    }
    if (applications.length === 0) failTo(back, "Enter how much to set against a bill");

    try {
      await applyVendorCredit({
        companyId: inner.companyId,
        vendorCreditId: id,
        applications,
        userId: inner.userId,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "vendor_credit.applied",
        entityType: "VendorCredit",
        entityId: id,
        summary: `${applications.length} bill${applications.length === 1 ? "" : "s"}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(`${back}?applied=1`);
  }

  async function unapply(formData: FormData) {
    "use server";
    const inner = await companyScope();
    try {
      await unapplyVendorCredit({
        companyId: inner.companyId,
        vendorCreditId: id,
        applicationId: String(formData.get("applicationId") || ""),
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "vendor_credit.unapplied",
        entityType: "VendorCredit",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(back);
  }

  async function makeVoid(formData: FormData) {
    "use server";
    const inner = await companyScope();
    try {
      await voidVendorCredit({
        companyId: inner.companyId,
        vendorCreditId: id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "vendor_credit.voided",
        entityType: "VendorCredit",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(`${back}?voided=1`);
  }

  const isVoid = credit.status === "VOID";
  const foreign = credit.currency !== company.baseCurrency;

  return (
    <>
      <PageHeader
        title={`Credit note ${credit.reference}`}
        description={`${credit.vendor.name} · ${formatAccountingDate(credit.date)} · ${credit.status
          .replace("_", " ")
          .toLowerCase()}`}
      />

      {params_.error ? <Alert tone="error">{params_.error}</Alert> : null}
      {params_.saved ? (
        <Alert tone="success">
          Recorded and posted. Accounts payable is down by{" "}
          {formatMoney(credit.amount.toFixed(2), credit.currency)}; set it against a bill below
          when you know which one it answers.
        </Alert>
      ) : null}
      {params_.applied ? <Alert tone="success">Applied. Nothing was posted.</Alert> : null}
      {isVoid ? <Alert tone="warning">This credit note is void.</Alert> : null}

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/vendor-credits?party=${party}`}>
          <Button variant="ghost">All credit notes</Button>
        </Link>
        <Link href={`/${party === "consultant" ? "consultants" : "vendors"}/${credit.vendorId}`}>
          <Button variant="ghost">{credit.vendor.name}</Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">The credit</h2>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Amount</dt>
                <dd className="tabular-nums">
                  {formatMoney(credit.amount.toFixed(2), credit.currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Left to use</dt>
                <dd className="tabular-nums">
                  {formatMoney(credit.balance.toFixed(2), credit.currency)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Account</dt>
                <dd>{account ? `${account.code} — ${account.name}` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Memo</dt>
                <dd>{credit.memo ?? "—"}</dd>
              </div>
            </dl>
            {foreign ? (
              <p className="mt-4 text-xs text-slate-500">
                Booked at {credit.fxRate.toFixed(4)} {company.baseCurrency} per {credit.currency} —{" "}
                {formatMoney(credit.baseTotal.toFixed(2), company.baseCurrency)} in the ledger. A
                credit can only be set against a bill in its own currency.
              </p>
            ) : null}
            {entries.length > 0 ? (
              <p className="mt-4 text-xs text-slate-500">
                Posted as{" "}
                {entries.map((entry, index) => (
                  <span key={entry.id}>
                    {index > 0 ? ", " : ""}
                    <Link className="underline" href={`/journal/${entry.id}`}>
                      entry {entry.entryNumber}
                    </Link>
                  </span>
                ))}
                .
              </p>
            ) : null}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Set against bills</h2>
            {credit.applications.length > 0 ? (
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2">Bill</th>
                    <th className="py-2">Date</th>
                    <th className="py-2 text-right">Applied</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {credit.applications.map((application) => (
                    <tr
                      key={application.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">
                        <Link className="underline" href={`/expenses/${application.expense.id}`}>
                          {application.expense.reference ?? application.expense.description}
                        </Link>
                      </td>
                      <td className="py-2 text-slate-500">
                        {formatAccountingDate(application.expense.date)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(application.amountApplied.toFixed(2), credit.currency)}
                      </td>
                      <td className="py-2 text-right">
                        {isVoid ? null : (
                          <form action={unapply}>
                            <input type="hidden" name="applicationId" value={application.id} />
                            <Button variant="ghost" type="submit">
                              Take off
                            </Button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            ) : (
              <p className="text-sm text-slate-500">
                Not set against anything yet. What is owed is already lower by the full amount —
                applying it only says which bill it answers.
              </p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {!isVoid && left.greaterThan(0) ? (
            <Card tone="muted">
              <h2 className="mb-3 text-sm font-semibold">Apply this credit</h2>
              {usable.length === 0 ? (
                <p className="text-sm text-slate-500">
                  {credit.vendor.name} has no open bill in {credit.currency} to set it against.
                  The credit keeps its balance until there is one.
                </p>
              ) : (
                <form action={apply} className="space-y-3">
                  {usable.map((bill) => (
                    <Field
                      key={bill.id}
                      label={`${bill.reference ?? bill.description} · ${formatMoney(
                        bill.balanceDue.toFixed(2),
                        bill.currency,
                      )} outstanding`}
                    >
                      <Input
                        name={`amount_${bill.id}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label={`Apply to ${bill.reference ?? bill.description}`}
                      />
                    </Field>
                  ))}
                  <Button type="submit" className="w-full">
                    Apply
                  </Button>
                  <p className="text-xs text-slate-500">
                    {formatMoney(credit.balance.toFixed(2), credit.currency)} left. Applying posts
                    nothing — both documents are already in accounts payable.
                  </p>
                </form>
              )}
            </Card>
          ) : null}

          {!isVoid ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Actions</h2>
              <form action={makeVoid} className="space-y-2">
                <Field label="Void date">
                  <Input type="date" name="date" defaultValue={isoDate(today())} />
                </Field>
                <Button type="submit" variant="danger" className="w-full">
                  Void credit note
                </Button>
              </form>
              <p className="mt-3 text-xs text-slate-500">
                The posting is reversed, so what is owed goes back up. Take the credit off every
                bill first — a bill settled by a voided credit would be settled by nothing.
              </p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
