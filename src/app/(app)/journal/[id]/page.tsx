import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { reverseJournalEntry } from "@/lib/ledger/post";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader } from "@/components/ui";

export default async function JournalEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;
  const { error } = await searchParams;

  const entry = await prisma.journalEntry.findFirst({
    where: { id, ...scope.where },
    include: {
      lines: { orderBy: { lineNumber: "asc" }, include: { account: true } },
      reversedBy: { select: { id: true, entryNumber: true } },
      reverses: { select: { id: true, entryNumber: true } },
    },
  });
  if (!entry) notFound();

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const total = sum(entry.lines.map((line) => money(line.debit)));

  async function reverse(formData: FormData) {
    "use server";
    const inner = await sectionScope("REPORTS");
    const date = new Date(`${String(formData.get("date"))}T00:00:00Z`);
    try {
      const reversal = await reverseJournalEntry({
        companyId: inner.companyId,
        entryId: id,
        date,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "journal_entry.reversed",
        entityType: "JournalEntry",
        entityId: id,
        summary: `Reversed by entry ${reversal.entryNumber}`,
      });
      redirect(`/journal/${reversal.id}`);
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/journal/${id}?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
  }

  return (
    <>
      <PageHeader
        title={`Journal entry ${entry.entryNumber}`}
        description={`${formatAccountingDate(entry.date)} · ${entry.sourceType
          .toLowerCase()
          .replace(/_/g, " ")}${entry.memo ? ` · ${entry.memo}` : ""}`}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {entry.reversedBy ? (
        <Alert tone="warning">
          Reversed by entry{" "}
          <Link className="underline" href={`/journal/${entry.reversedBy.id}`}>
            {entry.reversedBy.entryNumber}
          </Link>
          .
        </Alert>
      ) : null}
      {entry.reverses ? (
        <Alert tone="info">
          This entry reverses entry{" "}
          <Link className="underline" href={`/journal/${entry.reverses.id}`}>
            {entry.reverses.entryNumber}
          </Link>
          .
        </Alert>
      ) : null}

      <Card className="mt-4">
        <DataTable>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2">Account</th>
              <th className="py-2">Description</th>
              <th className="py-2 text-right">Debit</th>
              <th className="py-2 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                <td className="py-2">
                  <span className="font-mono text-xs text-slate-500">{line.account.code}</span>{" "}
                  {line.account.name}
                </td>
                <td className="py-2 text-slate-600 dark:text-slate-400">{line.description ?? "—"}</td>
                <td className="py-2 text-right tabular-nums">
                  {line.debit.isZero() ? "" : formatMoney(line.debit.toFixed(2), company.baseCurrency)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {line.credit.isZero()
                    ? ""
                    : formatMoney(line.credit.toFixed(2), company.baseCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="py-2" colSpan={2}>
                Total
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(total.toFixed(2), company.baseCurrency)}
              </td>
              <td className="py-2 text-right tabular-nums">
                {formatMoney(total.toFixed(2), company.baseCurrency)}
              </td>
            </tr>
          </tfoot>
        </DataTable>
      </Card>

      {!entry.reversedBy ? (
        <Card className="mt-6 max-w-md">
          <h2 className="text-sm font-semibold">Reverse this entry</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Posted entries are never edited. Reversing posts the mirror image; you then post the
            corrected entry.
          </p>
          <form action={reverse} className="mt-3 flex items-end gap-3">
            <Field label="Reversal date">
              <Input type="date" name="date" defaultValue={formatAccountingDate(today())} required />
            </Field>
            <Button variant="danger" type="submit">
              Reverse
            </Button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
