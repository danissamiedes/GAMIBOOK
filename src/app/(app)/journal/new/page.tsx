import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { postJournalEntry } from "@/lib/ledger/post";
import { parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { JournalLineEditor } from "@/components/journal-line-editor";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("New journal entry") };

export default async function NewJournalEntryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("REPORTS");
  const { error } = await searchParams;

  const accounts = await prisma.account.findMany({
    where: { ...scope.where, isActive: true },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  async function post(formData: FormData) {
    "use server";
    const inner = await sectionScope("REPORTS");

    const date = parseAccountingDate(String(formData.get("date") || ""));
    if (!date) redirect("/journal/new?error=date");

    const memo = String(formData.get("memo") || "").trim() || null;
    const lineCount = Number(formData.get("lineCount") || 0);

    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      if (!accountId) continue;

      const debit = parseMoney(String(formData.get(`line-${index}-debit`) || ""));
      const credit = parseMoney(String(formData.get(`line-${index}-credit`) || ""));
      if (!debit && !credit) continue;

      lines.push({
        accountId,
        debit: debit ?? 0,
        credit: credit ?? 0,
        description: String(formData.get(`line-${index}-description`) || "").trim() || null,
      });
    }

    try {
      const entry = await postJournalEntry({
        companyId: inner.companyId,
        date,
        memo,
        sourceType: "MANUAL",
        userId: inner.userId,
        role: inner.role,
        lines,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "journal_entry.posted",
        entityType: "JournalEntry",
        entityId: entry.id,
        summary: `Entry ${entry.entryNumber}${memo ? ` — ${memo}` : ""}`,
      });
      redirect(`/journal/${entry.id}`);
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        redirect(`/journal/new?error=${encodeURIComponent(thrown.message)}`);
      }
      throw thrown;
    }
  }

  return (
    <>
      <PageHeader
        title="New journal entry"
        description="Debits must equal credits. Once posted, an entry can only be corrected by reversing it."
      />
      {error ? (
        <Alert tone="error">{error === "date" ? "Enter a valid date." : error}</Alert>
      ) : null}
      <Card className="mt-4">
        <form action={post} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" hint="The accounting date. No time zone applies.">
              <Input type="date" name="date" defaultValue={formatAccountingDate(today())} required />
            </Field>
            <Field label="Memo">
              <Input name="memo" placeholder="What this entry is for" />
            </Field>
          </div>
          <JournalLineEditor accounts={accounts} />
          <Button type="submit">Post entry</Button>
        </form>
      </Card>
    </>
  );
}
