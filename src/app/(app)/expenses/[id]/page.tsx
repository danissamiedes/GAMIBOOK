import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { formatMoney } from "@/lib/currency";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { money, sum } from "@/lib/money";
import { linkLabel, safeExternalUrl } from "@/lib/links";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader } from "@/components/ui";
import { voidExpense } from "@/lib/payables/expenses";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { writeAudit } from "@/lib/audit";
import { TaskDialog } from "@/components/task-dialog";
import { addTask } from "@/app/(app)/tasks/actions";
import { assignableUsers } from "@/lib/tasks";

export const metadata = { title: pageTitle("Expense") };

/**
 * One expense or bill, on its own page (SPEC §8.2).
 *
 * A reference on a party's account is a promise that the document can be
 * opened; sending somebody to the list it happens to be on is not keeping it.
 * This is the document: what was bought, what it was coded to, what settled
 * it, and the entry it posted — with editing left where it already lives.
 *
 * **Who may read it is decided by whose bill it is.** A consultant's bill
 * belongs to the Consultants section and a supplier's to Vendors, so the
 * section is checked after the expense is found rather than before: the two
 * live in one table, and a single `sectionScope` at the top would either shut
 * out half the people entitled to read it or let the wrong half in.
 */
export default async function ExpensePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    void?: string;
    voided?: string;
    billed?: string;
    error?: string;
    taskSaved?: string;
    taskError?: string;
  }>;
}) {
  const scope = await companyScope();
  const { id } = await params;
  const params_ = await searchParams;
  const { saved, voided, error, taskSaved, taskError } = params_;

  const expense = await prisma.expense.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: { select: { id: true, name: true, kind: true } },
      receipt: { select: { id: true } },
      workOrder: { select: { id: true, workOrderNumber: true } },
      creditApplications: {
        orderBy: { createdAt: "asc" },
        include: {
          vendorCredit: { select: { id: true, reference: true, status: true } },
        },
      },
      applications: {
        include: {
          billPayment: {
            select: { id: true, date: true, reference: true, method: true, reversedAt: true },
          },
        },
      },
    },
  });
  if (!expense) notFound();

  const consultant = expense.vendor?.kind === "CONSULTANT";
  // Same rule as the lists these came from: a consultant's bill is not
  // readable by somebody who only holds Vendors, and the other way round.
  if (!scope.hasSection(consultant ? "CONSULTANTS" : "VENDORS")) notFound();

  // The accounts are ids on the expense rather than relations, so they are
  // read beside it rather than through it.
  const [company, accounts, customer, entry] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.account.findMany({
      where: {
        companyId: scope.companyId,
        id: { in: [expense.expenseAccountId, expense.paymentAccountId ?? ""] },
      },
      select: { id: true, code: true, name: true },
    }),
    expense.customerId
      ? prisma.customer.findFirst({
          where: { id: expense.customerId, companyId: scope.companyId },
          select: { name: true },
        })
      : Promise.resolve(null),
    prisma.journalEntry.findFirst({
      where: { companyId: scope.companyId, sourceType: "EXPENSE", sourceId: expense.id },
      orderBy: { postedAt: "asc" },
      include: {
        lines: { orderBy: { lineNumber: "asc" }, include: { account: true } },
        reversedBy: { select: { id: true, entryNumber: true } },
      },
    }),
  ]);

  const assignees = await assignableUsers(scope.companyId);
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const expenseAccount = byId.get(expense.expenseAccountId) ?? null;
  const paymentAccount = expense.paymentAccountId ? byId.get(expense.paymentAccountId) ?? null : null;

  /**
   * Voiding: the document stays, its posting is undone (SPEC §8.2).
   *
   * Dated to the expense by default, so the month it was wrongly in nets to
   * nothing — the same reasoning an amendment uses. A later date is offered
   * because a closed year is sometimes corrected in the open one instead,
   * and that is the accountant's call rather than ours.
   */
  async function voidIt(formData: FormData) {
    "use server";
    const inner = await companyScope();
    const back = `/expenses/${id}`;
    const when = parseAccountingDate(String(formData.get("date") || ""));
    try {
      await voidExpense({
        companyId: inner.companyId,
        expenseId: id,
        date: when ?? today(),
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "expense.voided",
        entityType: "Expense",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(`${back}?voided=1`);
  }

  const bill = expense.kind === "BILL";
  const listHref = consultant ? "/consultant-bills" : `/expenses?tab=${bill ? "bill" : "direct"}`;
  const editHref = `/expenses/${expense.id}/edit`;
  const live = expense.applications.filter((row) => !row.billPayment.reversedAt);
  // A credit note is not money: it settles part of the bill without anything
  // being paid, so it is listed beside the payments rather than among them.
  const liveCredits = expense.creditApplications.filter(
    (row) => row.vendorCredit.status !== "VOID",
  );
  // Offered only where it would be allowed: a paid bill must have its
  // payments reversed first, and a void expense is already void. The service
  // checks both again — this only decides whether to show the button.
  const voidable = expense.status !== "VOID" && live.length === 0;
  const confirmingVoid = voidable && params_.void === "1";
  const receiptUrl = safeExternalUrl(expense.receiptUrl);

  return (
    <>
      <PageHeader
        title={expense.reference ? `${bill ? "Bill" : "Expense"} ${expense.reference}` : expense.description}
        description={`${formatAccountingDate(expense.date)} · ${
          expense.vendor?.name ?? "no vendor"
        } · ${formatMoney(expense.amount.toFixed(2), expense.currency)}`}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={listHref}>
          <Button variant="ghost">{consultant ? "All consultant bills" : "All expenses"}</Button>
        </Link>
        {expense.vendor ? (
          <Link href={`/${consultant ? "consultants" : "vendors"}/${expense.vendor.id}`}>
            <Button variant="ghost">{expense.vendor.name}</Button>
          </Link>
        ) : null}
        {expense.status !== "VOID" ? (
          <Link href={editHref} className="ml-auto">
            <Button variant="secondary">Edit</Button>
          </Link>
        ) : null}
        {voidable ? (
          <Link href={`/expenses/${expense.id}?void=1`}>
            <Button variant="secondary">Void</Button>
          </Link>
        ) : null}
      </div>

      {saved ? (
        <Alert tone="success">
          Saved. {expense.status === "VOID" ? "" : "The entry below is what posted."}
        </Alert>
      ) : null}
      {voided ? (
        <Alert tone="success">
          Voided. The document stays on file and its posting has been reversed.
        </Alert>
      ) : null}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {taskSaved ? <Alert tone="success">Task saved.</Alert> : null}
      {taskError ? <Alert tone="error">{decodeURIComponent(taskError)}</Alert> : null}

      {params_.billed && expense.workOrder ? (
        <Alert tone="success">
          Work order {expense.workOrder.workOrderNumber} is now a bill. It is in accounts
          payable, and it is paid, credited and voided from here.
        </Alert>
      ) : null}

      {expense.status === "VOID" ? (
        <Alert tone="warning">
          This expense was voided{expense.voidedAt ? ` on ${formatAccountingDate(expense.voidedAt)}` : ""}.
          It stays on file, and its posting has been reversed.
        </Alert>
      ) : null}

      {confirmingVoid ? (
        <Card className="mb-4">
          <h2 className="mb-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
            Void this {bill ? "bill" : "expense"}?
          </h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            {formatMoney(expense.amount.toFixed(2), expense.currency)} — {expense.description}.
            The document stays exactly as it is and a reversing entry is posted against it, so
            the accounts read as though it had never been recorded. Nothing is deleted, and the
            reversal shows in the journal. To remove it altogether instead, delete it from the
            list — that is only possible while nothing has been built on it.
          </p>
          <form action={voidIt} className="flex flex-wrap items-end gap-3">
            <Field
              label="Reversal date"
              hint="Dated to the expense, so the month it was in nets to nothing."
            >
              <Input type="date" name="date" defaultValue={isoDate(expense.date)} />
            </Field>
            <Button variant="danger" type="submit">
              Void it
            </Button>
            <Link
              href={`/expenses/${expense.id}`}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </Link>
          </form>
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Amount</p>
          <p className="text-2xl font-bold tabular-nums">
            {formatMoney(expense.amount.toFixed(2), expense.currency)}
          </p>
          {expense.currency !== company.baseCurrency ? (
            <p className="mt-0.5 text-xs text-slate-500">
              {formatMoney(expense.baseTotal.toFixed(2), company.baseCurrency)} at{" "}
              {expense.fxRate.toString()}
            </p>
          ) : null}
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">
            {bill ? "Still owed" : "Paid from"}
          </p>
          <p className="text-2xl font-bold tabular-nums">
            {bill
              ? formatMoney(expense.balanceDue.toFixed(2), expense.currency)
              : paymentAccount
                ? `${paymentAccount.code}`
                : "—"}
          </p>
          {!bill && paymentAccount ? (
            <p className="mt-0.5 text-xs text-slate-500">{paymentAccount.name}</p>
          ) : null}
        </Card>
        <Card tone="muted">
          <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
          <p className="text-2xl font-bold">
            {expense.status.charAt(0) + expense.status.slice(1).toLowerCase()}
          </p>
          {bill && expense.dueDate ? (
            <p className="mt-0.5 text-xs text-slate-500">
              Due {formatAccountingDate(expense.dueDate)}
            </p>
          ) : null}
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">The document</h2>
          <dl className="space-y-2 text-sm">
            <Row term="Reference" value={expense.reference ?? "—"} />
            <Row term="Date" value={formatAccountingDate(expense.date)} />
            <Row term="Description" value={expense.description} />
            <Row term="Payee" value={expense.vendor?.name ?? "—"} />
            {expense.workOrder ? (
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 text-slate-500">From</dt>
                <dd className="font-medium">
                  <Link className="underline" href={`/work-orders/${expense.workOrder.id}`}>
                    Work order {expense.workOrder.workOrderNumber}
                  </Link>
                </dd>
              </div>
            ) : null}
            <Row
              term="Coded to"
              value={expenseAccount ? `${expenseAccount.code} ${expenseAccount.name}` : "—"}
            />
            {bill ? (
              <Row
                term="Owed on"
                value={expense.dueDate ? formatAccountingDate(expense.dueDate) : "—"}
              />
            ) : (
              <Row
                term="Paid from"
                value={
                  paymentAccount ? `${paymentAccount.code} ${paymentAccount.name}` : "—"
                }
              />
            )}
            {expense.isBillable ? (
              <Row term="Rebill to" value={customer?.name ?? "a customer"} />
            ) : null}
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 text-slate-500">Receipt</dt>
              <dd className="font-medium">
                {receiptUrl ? (
                  <a
                    className="underline"
                    href={receiptUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {linkLabel(receiptUrl)}
                  </a>
                ) : expense.receipt ? (
                  <Link className="underline" href={`/receipts/${expense.receipt.id}/image`} target="_blank">
                    Photo
                  </Link>
                ) : (
                  "—"
                )}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">
            {bill ? "What has been paid against it" : "How it posted"}
          </h2>

          {bill ? (
            live.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">
                Nothing paid yet.{" "}
                <Link href="/bill-payments" className="underline">
                  Record a payment
                </Link>
                .
              </p>
            ) : (
              <DataTable className="mb-4">
                <tbody>
                  {live.map((row) => (
                    <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2 pr-2 whitespace-nowrap text-sm">
                        {formatAccountingDate(row.billPayment.date)}
                      </td>
                      <td className="py-2 pr-2 font-mono text-xs">
                        <Link href={`/bill-payments/${row.billPayment.id}/edit`} className="underline">
                          {row.billPayment.reference ?? "payment"}
                        </Link>
                      </td>
                      <td className="py-2 text-right tabular-nums text-sm">
                        {formatMoney(row.amountApplied.toFixed(2), expense.currency)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-2 pr-2 text-sm font-semibold" colSpan={2}>
                      Paid
                    </td>
                    <td className="py-2 text-right font-semibold tabular-nums text-sm">
                      {formatMoney(
                        sum(live.map((row) => money(row.amountApplied))).toFixed(2),
                        expense.currency,
                      )}
                    </td>
                  </tr>
                </tbody>
              </DataTable>
            )
          ) : null}

          {bill && liveCredits.length > 0 ? (
            <DataTable className="mb-4">
              <tbody>
                {liveCredits.map((row) => (
                  <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2 pr-2 whitespace-nowrap text-sm">Credit note</td>
                    <td className="py-2 pr-2 font-mono text-xs">
                      <Link href={`/vendor-credits/${row.vendorCredit.id}`} className="underline">
                        {row.vendorCredit.reference}
                      </Link>
                    </td>
                    <td className="py-2 text-right tabular-nums text-sm">
                      {formatMoney(row.amountApplied.toFixed(2), expense.currency)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="py-2 pr-2 text-sm font-semibold" colSpan={2}>
                    Credited
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums text-sm">
                    {formatMoney(expense.creditedAmount.toFixed(2), expense.currency)}
                  </td>
                </tr>
              </tbody>
            </DataTable>
          ) : null}

          {entry ? (
            <>
              <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                Entry{" "}
                <Link href={`/journal/${entry.id}`} className="underline">
                  JE-{entry.entryNumber}
                </Link>{" "}
                · {formatAccountingDate(entry.date)}
                {entry.reversedBy ? " · reversed" : ""}
              </p>
              <DataTable>
                <tbody>
                  {entry.lines.map((line) => (
                    <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-1.5 pr-2 font-mono text-xs text-slate-500">
                        {line.account.code}
                      </td>
                      <td className="py-1.5 pr-2 text-sm">{line.account.name}</td>
                      <td className="py-1.5 pr-2 text-right tabular-nums text-sm">
                        {money(line.debit).isZero()
                          ? ""
                          : formatMoney(line.debit.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-sm">
                        {money(line.credit).isZero()
                          ? ""
                          : formatMoney(line.credit.toFixed(2), company.baseCurrency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </>
          ) : (
            <p className="text-sm text-slate-500">No posting found for this expense.</p>
          )}
        </Card>
      </div>

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">Follow this up</h2>
        <TaskDialog
          action={addTask}
          users={assignees}
          back={`/expenses/${expense.id}`}
          link={{ expenseId: expense.id }}
          defaultAssigneeId={scope.userId}
          today={isoDate(today())}
          label="Add a task"
          title={`Task on ${expense.description}`}
        />
      </Card>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-32 shrink-0 text-slate-500">{term}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
