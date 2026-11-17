import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import {
  BROWSE_LIMIT,
  MAX_BULK_PAYMENTS,
  payableConsultantDocuments,
} from "@/lib/payables/bulk-pay";
import { formatAccountingDate, isoDate, today } from "@/lib/dates";
import { money } from "@/lib/money";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { PayPanel, type PayableRow } from "./pay-panel";

export const metadata = { title: pageTitle("Pay consultant bills") };

/**
 * Paying consultants in one run (SPEC §6, §8.1b).
 *
 * Tick what is being paid, set one date and one account, confirm. The list is
 * what is actually outstanding, so a bill already settled cannot be paid twice
 * by being on screen.
 *
 * The confirm step is not ceremony. It is where the selection stops being a
 * list of documents and becomes a list of *payments*, one per consultant, and
 * seeing that before posting is the difference between a run you can check and
 * eighteen postings you have to unpick.
 *
 * Work orders raised under the earlier flow are listed beside the bills,
 * marked as what they are. They posted to accounts payable on approval and so
 * are payable in their own right; leaving them out would have meant no way to
 * settle them in a run at all.
 *
 * This page reads the list and draws the filter; the selection, the
 * confirmation and the run itself belong to the panel, because a run of any
 * size has to be posted in chunks and a loop needs somebody to run it.
 */
export default async function PayConsultantBillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    consultant?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const [company, consultants, paymentAccounts, documents] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    payableConsultantDocuments({
      companyId: scope.companyId,
      consultantId: params.consultant || null,
      from: params.from ? new Date(`${params.from}T00:00:00Z`) : null,
      to: params.to ? new Date(`${params.to}T00:00:00Z`) : null,
    }),
  ]);

  const legacyCount = documents.filter((document) => document.kind === "workOrder").length;
  /**
   * The list is capped, so a book with hundreds open shows the oldest and
   * stops. Said out loud rather than left to be noticed: a payment run that
   * silently omits what is owed is the one mistake this screen must not make.
   */
  const truncated =
    documents.filter((document) => document.kind === "bill").length >= BROWSE_LIMIT ||
    legacyCount >= BROWSE_LIMIT;

  const rows: PayableRow[] = documents.map((document) => ({
    kind: document.kind,
    id: document.id,
    consultantName: document.consultantName,
    label: document.label,
    date: formatAccountingDate(document.date),
    dueDate: document.dueDate ? formatAccountingDate(document.dueDate) : null,
    currency: document.currency,
    balanceDue: money(document.balanceDue).toFixed(2),
    href: document.kind === "bill" ? `/expenses/${document.id}` : `/work-orders/${document.id}`,
  }));

  return (
    <>
      <PageHeader
        title="Pay consultant bills"
        description="Tick what is being paid and settle it in one go. Each consultant gets their own payment, all on the date and account you choose here."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/consultant-bills">
          <Button variant="ghost">All consultant bills</Button>
        </Link>
        <Link href="/work-orders">
          <Button variant="ghost">Work orders</Button>
        </Link>
      </div>

      {paymentAccounts.length === 0 ? (
        <Alert tone="error">
          There is no cash or card account to pay from. Add one in the{" "}
          <Link className="underline" href="/accounts">
            chart of accounts
          </Link>{" "}
          first.
        </Alert>
      ) : null}

      <Card className="mb-4">
        <form className="flex flex-wrap items-end gap-3">
          <Field label="Consultant">
            <Select name="consultant" defaultValue={params.consultant ?? ""}>
              <option value="">All</option>
              {consultants.map((consultant) => (
                <option key={consultant.id} value={consultant.id}>
                  {consultant.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dated from">
            <Input type="date" name="from" defaultValue={params.from ?? ""} />
          </Field>
          <Field label="Dated to">
            <Input type="date" name="to" defaultValue={params.to ?? ""} />
          </Field>
          <Button variant="secondary" type="submit">
            Filter
          </Button>
        </form>
      </Card>

      {documents.length === 0 ? (
        <EmptyState title="Nothing outstanding">
          Everything owed to a consultant is settled, or nothing matches this filter. A
          consultant&apos;s work becomes a bill when its{" "}
          <Link className="underline" href="/work-orders">
            work order
          </Link>{" "}
          is converted, and the bill is what gets paid.
        </EmptyState>
      ) : (
        <Card>
          <PayPanel
            rows={rows}
            paymentAccounts={paymentAccounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            today={isoDate(today())}
            maxConsultants={MAX_BULK_PAYMENTS}
            truncated={truncated}
            browseLimit={BROWSE_LIMIT}
            baseCurrency={company.baseCurrency}
            legacyCount={legacyCount}
          />
        </Card>
      )}
    </>
  );
}
