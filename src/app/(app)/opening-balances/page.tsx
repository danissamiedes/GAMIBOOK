import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { postOpeningBalances } from "@/lib/ledger/opening-balances";
import { isBalanceSheet, SYSTEM_ACCOUNTS, TYPE_ORDER, normalBalance } from "@/lib/ledger/accounts";
import { parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: "Opening balances — Ledger" };

/**
 * Opening balances (SPEC §4.3). One entry, once, with the difference plugged
 * to Opening Balance Equity. Income and expense accounts are absent on
 * purpose: prior-year results are retained earnings, computed at report time.
 */
export default async function OpeningBalancesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const { error } = await searchParams;

  const existing = await prisma.journalEntry.findFirst({
    where: { ...scope.where, sourceType: "OPENING_BALANCE" },
  });

  const accounts = await prisma.account.findMany({
    where: { ...scope.where, isActive: true },
    orderBy: { code: "asc" },
  });
  const eligible = accounts.filter(
    (account) =>
      isBalanceSheet(account.type) &&
      account.systemKey !== SYSTEM_ACCOUNTS.OPENING_BALANCE_EQUITY,
  );

  async function post(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const date = parseAccountingDate(String(formData.get("date") || ""));
    if (!date) redirect("/opening-balances?error=Enter%20a%20valid%20date");

    const balances = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith("balance-")) continue;
      const amount = parseMoney(String(value));
      if (!amount || amount.isZero()) continue;
      balances.push({ accountId: key.slice("balance-".length), amount });
    }

    try {
      const entry = await postOpeningBalances({
        companyId: inner.companyId,
        date,
        balances,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "opening_balances.posted",
        entityType: "JournalEntry",
        entityId: entry.id,
        summary: `${balances.length} account balances as at ${formatAccountingDate(date)}`,
      });
      redirect(`/journal/${entry.id}`);
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/opening-balances?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
  }

  if (existing) {
    return (
      <>
        <PageHeader title="Opening balances" />
        <Alert tone="info">
          Opening balances were posted as entry{" "}
          <Link className="underline" href={`/journal/${existing.id}`}>
            {existing.entryNumber}
          </Link>
          . To adjust them, post a manual journal entry — the ledger is never edited in place.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Opening balances"
        description="Balances as at the day before your books start here. Enter each on its normal side; the difference goes to Opening Balance Equity."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="mt-4">
        <form action={post} className="space-y-5">
          <Field label="As at" hint="Usually the last day of the period you are migrating from.">
            <Input
              type="date"
              name="date"
              defaultValue={formatAccountingDate(today())}
              required
              className="max-w-xs"
            />
          </Field>

          {TYPE_ORDER.filter((type) => isBalanceSheet(type)).map((type) => {
            const rows = eligible.filter((account) => account.type === type);
            if (rows.length === 0) return null;
            return (
              <section key={type}>
                <h2 className="mb-2 text-sm font-semibold">
                  {type[0] + type.slice(1).toLowerCase()}{" "}
                  <span className="font-normal text-slate-500">
                    (positive = {normalBalance(type).toLowerCase()})
                  </span>
                </h2>
                <DataTable>
                  <tbody>
                    {rows.map((account) => (
                      <tr key={account.id}>
                        <td className="w-16 py-1 font-mono text-xs text-slate-500">
                          {account.code}
                        </td>
                        <td className="py-1">{account.name}</td>
                        <td className="w-44 py-1">
                          <Input
                            name={`balance-${account.id}`}
                            inputMode="decimal"
                            placeholder="0.00"
                            className="text-right"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </section>
            );
          })}

          <Button type="submit">Post opening balances</Button>
        </form>
      </Card>
    </>
  );
}
