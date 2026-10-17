import Link from "next/link";
import { redirect } from "next/navigation";
import type { JournalSourceType } from "@prisma/client";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import { findReclassifiableLines, planReclassification, LINE_LIMIT } from "@/lib/ledger/reclassify";
import {
  fiscalYearStart,
  formatAccountingDate,
  isoDate,
  parseAccountingDate,
  today,
} from "@/lib/dates";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { ReclassifyPicker } from "./picker";

export const metadata = { title: pageTitle("Reclassify transactions") };

/** The document kinds a posting can have come from, for the filter. */
const SOURCE_TYPES: JournalSourceType[] = [
  "MANUAL",
  "INVOICE",
  "INVOICE_PAYMENT",
  "WORK_ORDER",
  "CONSULTANT_PAYMENT",
  "EXPENSE",
  "BANK_TRANSACTION",
  "OPENING_BALANCE",
  "MIGRATION",
  "RECLASSIFICATION",
];

type Params = {
  account?: string;
  from?: string;
  to?: string;
  type?: string;
  reference?: string;
  description?: string;
  error?: string;
};

/**
 * Finding postings in the wrong account and moving them (SPEC §18).
 *
 * The filters are in the URL, so a half-finished job is a link somebody can
 * come back to, and the "same again for October" is an edit to the address
 * bar. What is selected is not: a selection that survived a reload would be a
 * selection made against rows that may have changed underneath it.
 */
export default async function ReclassifyPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const scope = await sectionScope("REPORTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { name: true, baseCurrency: true, fiscalYearStartMonth: true },
  });

  // Reclassifying is posting, and the ledger's own accounts are not posted to
  // by hand: their balances come from documents and the year's close.
  const accounts = await prisma.account.findMany({
    where: { companyId: scope.companyId, isActive: true, isSystem: false },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const to = parseAccountingDate(params.to ?? "") ?? today();
  const from =
    parseAccountingDate(params.from ?? "") ?? fiscalYearStart(to, company.fiscalYearStartMonth);
  const sourceType = SOURCE_TYPES.find((type) => type === params.type) ?? null;
  const fromAccount = accounts.find((account) => account.id === params.account) ?? null;

  const found = fromAccount
    ? await findReclassifiableLines({
        companyId: scope.companyId,
        accountId: fromAccount.id,
        from,
        to,
        sourceType,
        reference: params.reference,
        description: params.description,
      })
    : null;

  async function reclassify(formData: FormData) {
    "use server";
    const inner = await sectionScope("REPORTS");
    const lineIds = formData.getAll("lineId").map(String).filter(Boolean);
    const fromAccountId = String(formData.get("fromAccountId") ?? "");
    const toAccountId = String(formData.get("toAccountId") ?? "");
    const single = String(formData.get("dateMode") ?? "original") === "single";
    const chosenDate = parseAccountingDate(String(formData.get("date") ?? ""));
    const reason = String(formData.get("reason") ?? "");

    // The filters are carried through the round trip so the page comes back
    // showing the same account and period, now one batch lighter.
    const back = new URLSearchParams({
      account: fromAccountId,
      from: isoDate(from),
      to: isoDate(to),
      ...(sourceType ? { type: sourceType } : {}),
      ...(params.reference ? { reference: params.reference } : {}),
      ...(params.description ? { description: params.description } : {}),
    });

    // Planning settles every question and reserves the lines; the posting
    // itself happens on the batch's own page, a chunk at a time, because a
    // few hundred entries fit in neither one transaction nor one request.
    let plannedId: string;
    try {
      const planned = await planReclassification({
        companyId: inner.companyId,
        fromAccountId,
        toAccountId,
        journalLineIds: lineIds,
        date: single ? chosenDate : null,
        reason,
        userId: inner.userId,
        role: inner.role,
      });
      plannedId = planned.reclassificationId;
    } catch (thrown) {
      if (thrown instanceof PostingError) {
        back.set("error", thrown.message);
        redirect(`/reclassify?${back.toString()}`);
      }
      throw thrown;
    }
    redirect(`/reclassify/${plannedId}?run=1&back=${encodeURIComponent(back.toString())}`);
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Reclassify transactions"
          description={`Move postings from one account to another in ${company.name}. The originals are never changed.`}
        />
        <Link href="/reclassify/history">
          <Button variant="secondary">Reclassification history</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      <Card className="my-4">
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="From account">
            <Select name="account" defaultValue={fromAccount?.id ?? ""}>
              <option value="">Select an account…</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From date">
            <Input type="date" name="from" defaultValue={isoDate(from)} />
          </Field>
          <Field label="To date">
            <Input type="date" name="to" defaultValue={isoDate(to)} />
          </Field>
          <Field label="Transaction type">
            <Select name="type" defaultValue={sourceType ?? ""}>
              <option value="">Any</option>
              {SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type.toLowerCase().replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference contains">
            <Input name="reference" defaultValue={params.reference ?? ""} />
          </Field>
          <Field label="Description contains">
            <Input name="description" defaultValue={params.description ?? ""} />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
            <Button type="submit">Search</Button>
            <Link href="/reclassify">
              <Button type="button" variant="ghost">
                Reset filters
              </Button>
            </Link>
          </div>
        </form>
      </Card>

      {!fromAccount ? (
        <EmptyState title="Pick the account to look in">
          Choose the account the transactions were wrongly posted to, and the period to look at.
        </EmptyState>
      ) : found && found.lines.length === 0 ? (
        <EmptyState title="Nothing posted to that account in that period">
          {formatAccountingDate(from)} to {formatAccountingDate(to)}. Widen the dates, or clear the
          reference and description filters.
        </EmptyState>
      ) : found ? (
        <Card>
          {found.truncated ? (
            <Alert tone="info">
              Showing the first {LINE_LIMIT} postings. Narrow the period to see the rest.
            </Alert>
          ) : null}
          <ReclassifyPicker
            action={reclassify}
            currency={company.baseCurrency}
            defaultDate={isoDate(today())}
            fromAccount={fromAccount}
            accounts={accounts}
            lines={found.lines.map((line) => ({
              id: line.journalLineId,
              date: formatAccountingDate(line.date),
              reference: line.reference,
              sourceType: line.sourceType,
              description: line.description,
              debit: line.debit.toFixed(2),
              credit: line.credit.toFixed(2),
              amount: line.amount.toFixed(2),
              blockedReason: line.blockedReason,
            }))}
          />
        </Card>
      ) : null}
    </>
  );
}
