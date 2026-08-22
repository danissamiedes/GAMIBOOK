import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { companyScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { formatAccountingDate, isoDate } from "@/lib/dates";
import {
  closableMonths,
  closeBooksThrough,
  monthLabel,
  parseCloseDate,
  reopenAll,
} from "@/lib/periods/close";
import { PostingError, RoleError } from "@/lib/errors";
import { Alert, Button, Card, DataTable, Field, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Close period") };

/**
 * Month-end close (SPEC §4.2 rule 4). Owner-only, both here and in the service.
 *
 * The lock this page sets is enforced in exactly one place — `postJournalEntry`
 * — so it covers every document in the app rather than the ones someone
 * remembered to guard: bills, direct expenses and bill payments, and equally
 * invoices, customer payments, work orders, sales orders and journal entries.
 * That is the point of a period close. A month whose expenses are frozen but
 * whose revenue is not has a P&L that can still move after it was reported.
 */
export default async function ClosePeriodPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; closed?: string; reopened?: string }>;
}) {
  const scope = await companyScope();
  const { error, closed, reopened } = await searchParams;

  if (!scope.hasRole("OWNER")) {
    return (
      <>
        <PageHeader title="Close period" />
        <Alert tone="warning">
          Only an owner can close or reopen a period. Your role in this company is{" "}
          {scope.role.toLowerCase()}.
        </Alert>
      </>
    );
  }

  const [company, earliest] = await Promise.all([
    prisma.company.findUniqueOrThrow({
      where: { id: scope.companyId },
      select: { booksClosedThrough: true },
    }),
    prisma.journalEntry.findFirst({
      where: { companyId: scope.companyId },
      orderBy: { date: "asc" },
      select: { date: true },
    }),
  ]);

  const closedThrough = company.booksClosedThrough;
  const months = closableMonths({ earliest: earliest?.date ?? null });
  // A month already inside the closed period is not a close, it is a no-op.
  const toClose = closedThrough ? months.filter((m) => m.end > closedThrough) : months;
  const toReopen = closedThrough ? months.filter((m) => m.end < closedThrough) : [];

  const history = await prisma.auditLog.findMany({
    where: {
      companyId: scope.companyId,
      action: { in: ["period.closed", "period.reopened"] },
    },
    orderBy: { at: "desc" },
    take: 10,
    include: { user: { select: { name: true, email: true } } },
  });

  async function close(formData: FormData) {
    "use server";
    const inner = await companyScope();
    try {
      const date = parseCloseDate(String(formData.get("through") || ""));
      await closeBooksThrough(
        { companyId: inner.companyId, userId: inner.userId, role: inner.role },
        date,
      );
      redirect(`/close-period?closed=${isoDate(date)}`);
    } catch (caught) {
      if (caught instanceof PostingError || caught instanceof RoleError) {
        redirect(`/close-period?error=${encodeURIComponent(caught.message)}`);
      }
      throw caught;
    }
  }

  async function reopen(formData: FormData) {
    "use server";
    const inner = await companyScope();
    const back = String(formData.get("back") || "");
    try {
      if (back === "none") {
        await reopenAll({ companyId: inner.companyId, userId: inner.userId, role: inner.role });
        redirect("/close-period?reopened=all");
      }
      const date = parseCloseDate(back);
      await closeBooksThrough(
        { companyId: inner.companyId, userId: inner.userId, role: inner.role },
        date,
      );
      redirect(`/close-period?reopened=${isoDate(date)}`);
    } catch (caught) {
      if (caught instanceof PostingError || caught instanceof RoleError) {
        redirect(`/close-period?error=${encodeURIComponent(caught.message)}`);
      }
      throw caught;
    }
  }

  return (
    <>
      <PageHeader
        title="Close period"
        description="Freeze a month once it has been reviewed. Nothing dated on or before a closed month can be added, edited, reversed or deleted."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {closed ? (
        <Alert tone="success">Closed through {formatAccountingDate(new Date(closed))}.</Alert>
      ) : null}
      {reopened ? (
        <Alert tone="success">
          {reopened === "all"
            ? "Reopened. No period is closed."
            : `Reopened back to ${formatAccountingDate(new Date(reopened))}.`}
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Status</h2>
          {closedThrough ? (
            <>
              <p className="text-sm text-slate-700 dark:text-slate-200">
                The books are closed through{" "}
                <strong className="tabular-nums">{formatAccountingDate(closedThrough)}</strong>.
              </p>
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                Anyone other than an owner is refused when they try to post, edit or delete
                anything dated on or before that day. As an owner you can still make a
                correction — the form warns you first — so a genuine fix to a filed month does
                not need the period unlocked and locked again.
              </p>
            </>
          ) : (
            <p className="text-sm text-slate-700 dark:text-slate-200">
              No period is closed. Every month is still open to anyone who can post.
            </p>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Close a month</h2>
          {toClose.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {months.length === 0
                ? "Nothing has been posted yet, so there is no month to close."
                : "Every month that has ended is already closed."}
            </p>
          ) : (
            <form action={close} className="space-y-4">
              <Field
                label="Close the books through"
                hint="Only months that have already ended. Closing a month closes every month before it."
              >
                <Select name="through" defaultValue={toClose[0]?.value}>
                  {toClose.map((month) => (
                    <option key={month.value} value={month.value}>
                      {month.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex justify-end">
                <Button type="submit">Close period</Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      {closedThrough ? (
        <Card className="mt-6">
          <h2 className="mb-3 text-sm font-semibold">Reopen</h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            Reopening lets everyone post into the months you give back. Close them again when
            the correction is done.
          </p>
          <form action={reopen} className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label="Reopen back to">
                <Select name="back" defaultValue="none">
                  <option value="none">Reopen everything — nothing closed</option>
                  {toReopen.map((month) => (
                    <option key={month.value} value={month.value}>
                      Keep {monthLabel(month.end)} and earlier closed
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button type="submit" variant="secondary">
              Reopen
            </Button>
          </form>
        </Card>
      ) : null}

      <Card className="mt-6">
        <h2 className="mb-3 text-sm font-semibold">History</h2>
        {history.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No period has been closed or reopened yet.
          </p>
        ) : (
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">When</th>
                <th className="py-2">Who</th>
                <th className="py-2">What</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2 tabular-nums">{formatAccountingDate(row.at)}</td>
                  <td className="py-2">{row.user?.name || row.user?.email || "—"}</td>
                  <td className="py-2">{row.summary}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Card>
    </>
  );
}
