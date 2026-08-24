import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { failTo } from "@/lib/fail";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, parseMoney } from "@/lib/money";
import {
  completeReconciliation,
  openReconciliation,
  openingBalanceFor,
  reconciliationView,
  reopenReconciliation,
  setAllCleared,
  setLineCleared,
} from "@/lib/bank/reconcile";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from "@/components/ui";

export const metadata = { title: pageTitle("Reconcile") };

/**
 * Where every action returns to.
 *
 * Module scope, not a closure inside the component: a server action that
 * captures a plain function fails at runtime with "Functions cannot be passed
 * directly to Client Components", because Next tries to serialise it.
 */
function backTo(accountId: string) {
  return `/banking/reconcile?account=${accountId}`;
}

/**
 * Bank reconciliation (SPEC §8.4a).
 *
 * The screen is the arithmetic: an opening balance you agreed last time, the
 * lines you tick as appearing on this statement, and a difference that has to
 * reach zero before it can be signed off. Everything else on the page exists to
 * explain a difference that will not close — which is the only interesting
 * state a reconciliation ever has.
 */
export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    error?: string;
    done?: string;
    reopened?: string;
  }>;
}) {
  const scope = await sectionScope("BANKING");
  const params = await searchParams;

  const [company, accounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.bankAccount.findMany({
      where: { ...scope.where, isActive: true },
      include: { account: { select: { code: true, name: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const selected =
    accounts.find((account) => account.id === params.account) ?? accounts[0] ?? null;

  const [open, history] = selected
    ? await Promise.all([
        prisma.bankReconciliation.findFirst({
          where: {
            ...scope.where,
            bankAccountId: selected.id,
            status: "IN_PROGRESS" as const,
          },
        }),
        prisma.bankReconciliation.findMany({
          where: { ...scope.where, bankAccountId: selected.id, status: "COMPLETED" as const },
          orderBy: { statementDate: "desc" },
          take: 12,
        }),
      ])
    : [null, []];

  const view = open
    ? await reconciliationView({ companyId: scope.companyId, reconciliationId: open.id })
    : null;

  // The last signed-off balance, so the start form can say where this one
  // begins rather than leaving someone to work it out.
  const nextOpening = selected
    ? await openingBalanceFor(scope.companyId, selected.id)
    : money(0);

  const amount = (value: { toFixed: (n: number) => string }) =>
    formatMoney(value.toFixed(2), selected?.currency ?? company.baseCurrency);

  async function start(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const bankAccountId = String(formData.get("bankAccountId"));
    const back = backTo(bankAccountId);

    const statementDate = parseAccountingDate(String(formData.get("statementDate") || ""));
    if (!statementDate) failTo(back, "Give the statement's closing date");
    const ending = parseMoney(String(formData.get("statementEndingBalance") || ""));
    if (ending === null) failTo(back, "Give the balance the statement closes at");

    try {
      await openReconciliation({
        companyId: inner.companyId,
        bankAccountId,
        statementDate: statementDate!,
        statementEndingBalance: ending!,
        userId: inner.userId,
      });
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect(back);
  }

  async function toggle(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const reconciliationId = String(formData.get("reconciliationId"));
    const back = backTo(String(formData.get("bankAccountId")));
    try {
      await setLineCleared({
        companyId: inner.companyId,
        reconciliationId,
        journalLineId: String(formData.get("journalLineId")),
        cleared: formData.get("cleared") === "1",
      });
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect(back);
  }

  async function toggleAll(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const back = backTo(String(formData.get("bankAccountId")));
    try {
      await setAllCleared({
        companyId: inner.companyId,
        reconciliationId: String(formData.get("reconciliationId")),
        cleared: formData.get("cleared") === "1",
      });
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect(back);
  }

  async function finish(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const back = backTo(String(formData.get("bankAccountId")));
    try {
      await completeReconciliation({
        companyId: inner.companyId,
        reconciliationId: String(formData.get("reconciliationId")),
        userId: inner.userId,
      });
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect(`${back}&done=1`);
  }

  async function reopen(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const back = backTo(String(formData.get("bankAccountId")));
    // Undoing a sign-off frees entries that were locked, so it is an owner's
    // decision, not a bookkeeper's.
    inner.requireRole("OWNER");
    try {
      await reopenReconciliation({
        companyId: inner.companyId,
        reconciliationId: String(formData.get("reconciliationId")),
        userId: inner.userId,
      });
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect(`${back}&reopened=1`);
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Reconcile"
          description="Tick what the statement shows until the difference is zero, then sign it off."
        />
        <Link href="/banking">
          <Button variant="secondary">Bank accounts</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.done ? (
        <Alert tone="success">
          Reconciled. The entries it cleared are frozen — they can be reversed, but not edited or
          deleted, until this reconciliation is reopened.
        </Alert>
      ) : null}
      {params.reopened ? (
        <Alert tone="info">Reopened. The entries it cleared can be changed again.</Alert>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          title="No bank accounts yet"
          action={{ href: "/banking", label: "Add a bank account" }}
        >
          A reconciliation is against one account, so there has to be one first.
        </EmptyState>
      ) : (
        <>
          {accounts.length > 1 ? (
            <div className="mb-4 flex flex-wrap gap-2">
              {accounts.map((account) => (
                <Link key={account.id} href={backTo(account.id)}>
                  <Button variant={account.id === selected?.id ? "primary" : "secondary"}>
                    {account.name}
                  </Button>
                </Link>
              ))}
            </div>
          ) : null}

          {selected && !view ? (
            <Card className="max-w-2xl">
              <h2 className="mb-1 text-sm font-semibold">Start a reconciliation</h2>
              <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
                {selected.name} · {selected.account.code} {selected.account.name}. It starts from{" "}
                <strong className="tabular-nums">{amount(nextOpening)}</strong>, the balance the
                last statement was signed off at.
              </p>
              <form action={start} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="bankAccountId" value={selected.id} />
                <Field
                  label="Statement closing date"
                  hint="Only entries on or before this can clear."
                >
                  <Input
                    type="date"
                    name="statementDate"
                    defaultValue={isoDate(today())}
                    className="w-44"
                    required
                  />
                </Field>
                <Field label={`Closing balance (${selected.currency})`}>
                  <Input
                    name="statementEndingBalance"
                    inputMode="decimal"
                    className="w-44"
                    required
                  />
                </Field>
                <Button type="submit">Start</Button>
              </form>
            </Card>
          ) : null}

          {selected && view ? (
            <>
              <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Opening balance</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {amount(view.reconciliation.openingBalance)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Signed off last time.</p>
                </Card>
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Cleared</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {amount(view.clearedTotal)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {view.lines.filter((line) => line.cleared).length} of {view.lines.length} lines.
                  </p>
                </Card>
                <Card>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Statement closes at
                  </p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {amount(view.reconciliation.statementEndingBalance)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    on {formatAccountingDate(view.reconciliation.statementDate)}.
                  </p>
                </Card>
                <Card tone={view.balanced ? "default" : "muted"}>
                  <p className="text-xs uppercase tracking-wide text-slate-500">Difference</p>
                  <p
                    className={`mt-1 text-lg font-semibold tabular-nums ${
                      view.balanced
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-red-700 dark:text-red-400"
                    }`}
                  >
                    {amount(view.difference)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {view.balanced
                      ? "Balanced — ready to sign off."
                      : "Must be zero to finish."}
                  </p>
                </Card>
              </div>

              <Card className="mb-4">
                {/* The statement figures have to stay editable while the
                    reconciliation is open. Mistyping the closing balance is the
                    single most likely reason a difference will not close, and
                    without this the only way out is to be told to reopen
                    something that was never finished. */}
                <form action={start} className="mb-4 flex flex-wrap items-end gap-3">
                  <input type="hidden" name="bankAccountId" value={selected.id} />
                  <Field label="Statement closing date">
                    <Input
                      type="date"
                      name="statementDate"
                      defaultValue={isoDate(view.reconciliation.statementDate)}
                      className="w-44"
                      required
                    />
                  </Field>
                  <Field label={`Closing balance (${selected.currency})`}>
                    <Input
                      name="statementEndingBalance"
                      inputMode="decimal"
                      defaultValue={view.reconciliation.statementEndingBalance.toFixed(2)}
                      className="w-44"
                      required
                    />
                  </Field>
                  <Button variant="secondary" type="submit">
                    Update statement
                  </Button>
                </form>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-slate-600 dark:text-slate-300">
                    <strong className="tabular-nums">{amount(view.outstandingTotal)}</strong>{" "}
                    outstanding — recorded in the books, not on this statement. An uncashed cheque
                    lives here, and so does a difference nobody has explained yet.
                  </div>
                  <div className="flex gap-2">
                    <form action={toggleAll}>
                      <input type="hidden" name="reconciliationId" value={view.reconciliation.id} />
                      <input type="hidden" name="bankAccountId" value={selected.id} />
                      <input type="hidden" name="cleared" value="1" />
                      <Button variant="secondary" type="submit">
                        Tick all
                      </Button>
                    </form>
                    <form action={toggleAll}>
                      <input type="hidden" name="reconciliationId" value={view.reconciliation.id} />
                      <input type="hidden" name="bankAccountId" value={selected.id} />
                      <input type="hidden" name="cleared" value="0" />
                      <Button variant="ghost" type="submit">
                        Untick all
                      </Button>
                    </form>
                    <form action={finish}>
                      <input type="hidden" name="reconciliationId" value={view.reconciliation.id} />
                      <input type="hidden" name="bankAccountId" value={selected.id} />
                      <Button type="submit" disabled={!view.balanced}>
                        Finish reconciliation
                      </Button>
                    </form>
                  </div>
                </div>
              </Card>

              <Card>
                {view.lines.length === 0 ? (
                  <EmptyState title="Nothing to reconcile on or before this date">
                    Every entry against this account up to{" "}
                    {formatAccountingDate(view.reconciliation.statementDate)} has already been
                    cleared on an earlier statement.
                  </EmptyState>
                ) : (
                  <DataTable>
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                        <th className="py-2 w-24">On statement</th>
                        <th className="py-2 pr-4">Date</th>
                        <th className="py-2 pr-4">Entry</th>
                        <th className="py-2 pr-4">Description</th>
                        <th className="py-2 pr-4">Party</th>
                        <th className="py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.lines.map((line) => (
                        <tr
                          key={line.lineId}
                          className={`border-b border-slate-100 dark:border-slate-800/60 ${
                            line.cleared ? "" : "bg-amber-50/40 dark:bg-amber-950/10"
                          }`}
                        >
                          <td className="py-1.5">
                            <form action={toggle}>
                              <input
                                type="hidden"
                                name="reconciliationId"
                                value={view.reconciliation.id}
                              />
                              <input type="hidden" name="bankAccountId" value={selected.id} />
                              <input type="hidden" name="journalLineId" value={line.lineId} />
                              <input
                                type="hidden"
                                name="cleared"
                                value={line.cleared ? "0" : "1"}
                              />
                              <Button variant="ghost" type="submit">
                                {line.cleared ? "✓ cleared" : "— outstanding"}
                              </Button>
                            </form>
                          </td>
                          <td className="py-1.5 pr-4 tabular-nums">
                            {formatAccountingDate(line.date)}
                          </td>
                          <td className="py-1.5 pr-4 font-mono text-xs">
                            <Link className="underline" href={`/journal/${line.entryId}`}>
                              {line.entryNumber}
                            </Link>
                          </td>
                          <td className="py-1.5 pr-4">{line.description ?? line.memo ?? "—"}</td>
                          <td className="py-1.5 pr-4 text-slate-500">{line.partyName ?? "—"}</td>
                          <td className="py-1.5 text-right tabular-nums">{amount(line.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                )}
              </Card>
            </>
          ) : null}

          {history.length > 0 ? (
            <Card className="mt-6">
              <h2 className="mb-3 text-sm font-semibold">Signed off</h2>
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-4">Statement date</th>
                    <th className="py-2 pr-4 text-right">Closing balance</th>
                    <th className="py-2 pr-4">Completed</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, index) => (
                    <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2 pr-4 tabular-nums">
                        {formatAccountingDate(row.statementDate)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {amount(money(row.statementEndingBalance))}
                      </td>
                      <td className="py-2 pr-4 text-xs text-slate-500">
                        {row.completedAt ? formatAccountingDate(row.completedAt) : "—"}
                      </td>
                      <td className="py-2 text-right">
                        {/* Only the most recent: a later reconciliation opened
                            from this one's balance, so reopening an earlier
                            statement would leave the ones after it resting on a
                            figure nobody has agreed to. */}
                        {index === 0 && scope.hasRole("OWNER") && !open ? (
                          <form action={reopen}>
                            <input type="hidden" name="reconciliationId" value={row.id} />
                            <input type="hidden" name="bankAccountId" value={selected!.id} />
                            <Button variant="ghost" type="submit">
                              Reopen
                            </Button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
