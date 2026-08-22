import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import {
  categoriseDirectly,
  linkToPayment,
  setExcluded,
  settleWithPayment,
  suggestCandidates,
  unmatch,
} from "@/lib/bank/match";
import { openDocumentsForVendor } from "@/lib/payables/bill-payments";
import { PostingError } from "@/lib/errors";
import { money } from "@/lib/money";
import { formatAccountingDate } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: pageTitle("Match bank transactions") };

/**
 * Where a match action returns to.
 *
 * Module scope on purpose: a server action serialises what it captures, and a
 * captured *function* cannot be serialised — a `const back = () => …` beside
 * these actions throws "Functions cannot be passed directly to Client
 * Components" on every render while the page still answers 200. The same trap
 * as `failTo`, which is why that lives in its own module too.
 */
function matchUrl(accountId: string, showMatched: boolean, extra = "") {
  return `/banking/match?account=${accountId}${showMatched ? "&show=matched" : ""}${extra}`;
}

/**
 * Reconciling (SPEC §8.4). One line at a time, with the three outcomes side by
 * side and labelled by what each does to the ledger — because the difference
 * between them is the difference between counting cash once and twice, and it
 * is not obvious from the buttons alone.
 */
export default async function BankMatchPage({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    line?: string;
    payee?: string;
    show?: string;
    page?: string;
    error?: string;
    imported?: string;
    done?: string;
  }>;
}) {
  const scope = await sectionScope("BANKING");
  const params = await searchParams;

  const accounts = await prisma.bankAccount.findMany({
    where: scope.where,
    orderBy: { name: "asc" },
  });
  if (accounts.length === 0) redirect("/banking");

  const bankAccount =
    accounts.find((account) => account.id === params.account) ?? accounts[0];
  const showMatched = params.show === "matched";
  // Captured by the server actions below, so it must be a plain string.
  const accountId = bankAccount.id;

  const page = readPage(params);
  const transactionWhere: Prisma.BankTransactionWhereInput = {
    companyId: scope.companyId,
    bankAccountId: bankAccount.id,
    status: showMatched ? "MATCHED" : { in: ["UNMATCHED", "EXCLUDED"] },
  };

  const [transactions, unmatchedTotal, listTotal] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: transactionWhere,
      include: {
        matchedPayment: { include: { customer: { select: { name: true } } } },
        matchedBillPayment: { include: { vendor: { select: { name: true } } } },
        matchedJournalEntry: { select: { entryNumber: true, id: true } },
      },
      orderBy: { date: "asc" },
      skip: page.skip,
      take: page.take,
    }),
    prisma.bankTransaction.count({
      where: {
        companyId: scope.companyId,
        bankAccountId: bankAccount.id,
        status: "UNMATCHED",
      },
    }),
    prisma.bankTransaction.count({ where: transactionWhere }),
  ]);

  const summary = pageSummary(page, listTotal, "line");

  // The line being worked on, with everything needed to offer all three routes.
  const selected = params.line
    ? (transactions.find((transaction) => transaction.id === params.line) ??
      null)
    : null;

  const [candidates, vendors, postingAccounts, openInvoices] = selected
    ? await Promise.all([
        suggestCandidates({
          companyId: scope.companyId,
          transactionId: selected.id,
        }),
        prisma.vendor.findMany({
          where: { ...scope.where, isActive: true },
          orderBy: { name: "asc" },
        }),
        prisma.account.findMany({
          where: {
            ...scope.where,
            isActive: true,
            type: { in: ["EXPENSE", "INCOME"] },
          },
          orderBy: { code: "asc" },
        }),
        prisma.invoice.findMany({
          where: {
            ...scope.where,
            status: { in: ["ISSUED", "PARTIALLY_PAID"] },
          },
          include: { customer: { select: { id: true, name: true } } },
          orderBy: { dueDate: "asc" },
          take: 100,
        }),
      ])
    : [[], [], [], []];

  const selectedAmount = selected ? money(selected.amount) : null;
  const incoming = selectedAmount ? selectedAmount.greaterThan(0) : true;

  // For money out, the payee drives the document list — picking one and
  // seeing an empty list is worse than useless, so the choice reloads.
  const vendorForDocuments =
    params.line && !incoming ? (params.payee ?? vendors[0]?.id ?? null) : null;
  const openForVendor = vendorForDocuments
    ? await openDocumentsForVendor(scope.companyId, vendorForDocuments)
    : [];

  const back = (extra = "") => matchUrl(accountId, showMatched, extra);

  async function doLink(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const transactionId = String(formData.get("transactionId"));
    const [kind, id] = String(formData.get("candidate") || "").split(":");
    if (!kind || !id)
      failTo(
        matchUrl(accountId, showMatched, `&line=${transactionId}`),
        "Pick a payment to link to",
      );
    try {
      await linkToPayment({
        companyId: inner.companyId,
        transactionId,
        paymentId: kind === "payment" ? id : undefined,
        billPaymentId: kind === "billPayment" ? id : undefined,
        userId: inner.userId,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bankTransaction.linked",
        entityType: "BankTransaction",
        entityId: transactionId,
        summary: "Linked to an existing payment — nothing posted",
      });
    } catch (error) {
      if (error instanceof PostingError)
        failTo(
          matchUrl(accountId, showMatched, `&line=${transactionId}`),
          error.message,
        );
      throw error;
    }
    redirect(matchUrl(accountId, showMatched, "&done=linked"));
  }

  async function doSettle(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const transactionId = String(formData.get("transactionId"));
    const where = matchUrl(accountId, showMatched, `&line=${transactionId}`);
    const documentId = String(formData.get("documentId") || "");
    if (!documentId) failTo(where, "Pick the document this settles");

    const [type, id] = documentId.split(":");
    const amount = String(formData.get("amount") || "");
    // The invoice decides whose payment this is, so the customer is read
    // from it rather than from a second dropdown that could disagree.
    const invoice =
      type === "invoice"
        ? await prisma.invoice.findFirst({
            where: { id, companyId: inner.companyId },
            select: { customerId: true },
          })
        : null;
    if (type === "invoice" && !invoice) failTo(where, "Invoice not found");

    try {
      await settleWithPayment({
        companyId: inner.companyId,
        transactionId,
        customerId: invoice?.customerId,
        vendorId:
          type === "invoice" ? undefined : String(formData.get("vendorId")),
        applications: [
          type === "invoice"
            ? { invoiceId: id, amountApplied: amount }
            : type === "workOrder"
              ? { workOrderId: id, amountApplied: amount }
              : { expenseId: id, amountApplied: amount },
        ],
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bankTransaction.settled",
        entityType: "BankTransaction",
        entityId: transactionId,
        summary: `Created a payment for ${amount}`,
      });
    } catch (error) {
      if (error instanceof PostingError) failTo(where, error.message);
      throw error;
    }
    redirect(matchUrl(accountId, showMatched, "&done=settled"));
  }

  async function doCategorise(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const transactionId = String(formData.get("transactionId"));
    const where = matchUrl(accountId, showMatched, `&line=${transactionId}`);
    const postToAccountId = String(formData.get("accountId") || "");
    if (!postToAccountId) failTo(where, "Pick the account to post this to");
    try {
      await categoriseDirectly({
        companyId: inner.companyId,
        transactionId,
        accountId: postToAccountId,
        memo: String(formData.get("memo") || "") || null,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bankTransaction.categorised",
        entityType: "BankTransaction",
        entityId: transactionId,
      });
    } catch (error) {
      if (error instanceof PostingError) failTo(where, error.message);
      throw error;
    }
    redirect(matchUrl(accountId, showMatched, "&done=categorised"));
  }

  async function doUnmatch(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const transactionId = String(formData.get("transactionId"));
    try {
      await unmatch({
        companyId: inner.companyId,
        transactionId,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bankTransaction.unmatched",
        entityType: "BankTransaction",
        entityId: transactionId,
      });
    } catch (error) {
      if (error instanceof PostingError)
        failTo(matchUrl(accountId, showMatched), error.message);
      throw error;
    }
    redirect(matchUrl(accountId, showMatched, "&done=unmatched"));
  }

  async function doExclude(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const transactionId = String(formData.get("transactionId"));
    try {
      await setExcluded({
        companyId: inner.companyId,
        transactionId,
        excluded: String(formData.get("excluded")) === "true",
      });
    } catch (error) {
      if (error instanceof PostingError)
        failTo(matchUrl(accountId, showMatched), error.message);
      throw error;
    }
    redirect(matchUrl(accountId, showMatched));
  }

  const doneMessage: Record<string, string> = {
    linked:
      "Linked to the existing payment. Nothing was posted — the entry was already there.",
    settled: "Payment created and the document settled.",
    categorised: "Posted.",
    unmatched: "Unmatched.",
  };

  return (
    <>
      <PageHeader
        title="Match bank transactions"
        description={`${bankAccount.name} · ${unmatchedTotal} waiting`}
      />

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.imported ? (
        <Alert tone="success">
          {params.imported} line(s) imported. Match them below.
        </Alert>
      ) : null}
      {params.done ? (
        <Alert tone="success">{doneMessage[params.done] ?? params.done}</Alert>
      ) : null}

      <div className="mb-4 mt-4 flex flex-wrap gap-2">
        {accounts.map((account) => (
          <Link key={account.id} href={`/banking/match?account=${account.id}`}>
            <Button
              variant={account.id === bankAccount.id ? "primary" : "secondary"}
            >
              {account.name}
            </Button>
          </Link>
        ))}
        <Link
          href={
            back().replace(/&show=matched/, "") +
            (showMatched ? "" : "&show=matched")
          }
        >
          <Button variant="ghost">
            {showMatched ? "Show unmatched" : "Show matched"}
          </Button>
        </Link>
        <Link href="/banking">
          <Button variant="ghost">Import a statement</Button>
        </Link>
      </div>

      {transactions.length === 0 ? (
        <EmptyState
          title={showMatched ? "Nothing matched yet" : "Nothing waiting"}
          action={{ href: "/banking", label: "Import a statement" }}
        >
          {showMatched
            ? "Matched lines appear here with what each one points at."
            : "Every line in this account has been accounted for."}
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Date</th>
                <th className="py-2">Description</th>
                <th className="py-2 text-right">Amount</th>
                <th className="py-2">
                  {showMatched ? "Accounted for by" : ""}
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transactions.map((transaction) => {
                const amount = money(transaction.amount);
                const isSelected = selected?.id === transaction.id;
                return (
                  <tr
                    key={transaction.id}
                    className={`border-b border-slate-100 dark:border-slate-800/60 ${
                      isSelected ? "bg-slate-50 dark:bg-slate-800/40" : ""
                    }`}
                  >
                    <td className="py-2 tabular-nums">
                      {formatAccountingDate(transaction.date)}
                    </td>
                    <td className="py-2">
                      {transaction.description}
                      {transaction.reference ? (
                        <span className="ml-2 text-xs text-slate-500">
                          {transaction.reference}
                        </span>
                      ) : null}
                      {transaction.status === "EXCLUDED" ? (
                        <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                          excluded
                        </span>
                      ) : null}
                    </td>
                    <td
                      className={`py-2 text-right tabular-nums ${
                        amount.isNegative()
                          ? "text-red-700 dark:text-red-300"
                          : ""
                      }`}
                    >
                      {formatMoney(amount.toFixed(2), bankAccount.currency)}
                    </td>
                    <td className="py-2 text-xs text-slate-500">
                      {transaction.matchedPayment
                        ? `Payment from ${transaction.matchedPayment.customer.name}`
                        : transaction.matchedBillPayment
                          ? `Payment to ${transaction.matchedBillPayment.vendor.name}`
                          : transaction.matchedJournalEntry
                            ? `Journal ${transaction.matchedJournalEntry.entryNumber}`
                            : ""}
                      {transaction.status === "MATCHED" ? (
                        <span className="ml-2 text-slate-400">
                          {transaction.createdEntry
                            ? "(posted here)"
                            : "(already posted)"}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      {transaction.status === "MATCHED" ? (
                        <form action={doUnmatch}>
                          <input
                            type="hidden"
                            name="transactionId"
                            value={transaction.id}
                          />
                          <Button variant="ghost" type="submit">
                            Unmatch
                          </Button>
                        </form>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Link href={back(`&line=${transaction.id}`)}>
                            <Button
                              variant={isSelected ? "primary" : "secondary"}
                            >
                              Match
                            </Button>
                          </Link>
                          <form action={doExclude}>
                            <input
                              type="hidden"
                              name="transactionId"
                              value={transaction.id}
                            />
                            <input
                              type="hidden"
                              name="excluded"
                              value={String(transaction.status !== "EXCLUDED")}
                            />
                            <Button variant="ghost" type="submit">
                              {transaction.status === "EXCLUDED"
                                ? "Restore"
                                : "Ignore"}
                            </Button>
                          </form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/banking/match", params, page.page - 1)}
            nextHref={pageHref("/banking/match", params, page.page + 1)}
          />
        </Card>
      )}

      {selected && selected.status !== "MATCHED" ? (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold">
            {formatAccountingDate(selected.date)} · {selected.description} ·{" "}
            {formatMoney(
              money(selected.amount).toFixed(2),
              bankAccount.currency,
            )}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Three ways to account for this, and they do different things to the
            ledger. Pick the one that is true.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                1 · Already recorded
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                The payment is in the app and this is the bank confirming it.{" "}
                <strong>Posts nothing.</strong>
              </p>
              {candidates.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  No payment of this amount within five days.
                </p>
              ) : (
                <form action={doLink} className="mt-3 space-y-2">
                  <input
                    type="hidden"
                    name="transactionId"
                    value={selected.id}
                  />
                  <Select name="candidate">
                    {candidates.map((candidate) => (
                      <option
                        key={candidate.id}
                        value={`${candidate.kind}:${candidate.id}`}
                      >
                        {formatAccountingDate(candidate.date)} ·{" "}
                        {candidate.party}
                        {candidate.reference ? ` · ${candidate.reference}` : ""}
                      </option>
                    ))}
                  </Select>
                  <Button type="submit">Link</Button>
                </form>
              )}
            </div>

            <div className="min-w-0 rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                2 · Settle a document
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                No payment yet. Creates one and settles what it pays.{" "}
                <strong>Posts the settlement.</strong>
              </p>
              <form action={doSettle} className="mt-3 space-y-2">
                <input type="hidden" name="transactionId" value={selected.id} />
                <input
                  type="hidden"
                  name="amount"
                  value={money(selected.amount).abs().toFixed(2)}
                />
                {incoming ? (
                  // The invoice names its own customer, so asking again only
                  // creates a way for the two to disagree.
                  <Select name="documentId" required>
                    <option value="">Pick an invoice…</option>
                    {openInvoices.map((invoice) => (
                      <option key={invoice.id} value={`invoice:${invoice.id}`}>
                        {invoice.invoiceNumber ?? "draft"} ·{" "}
                        {invoice.customer.name} ·{" "}
                        {money(invoice.balanceDue).toFixed(2)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <>
                    <input
                      type="hidden"
                      name="vendorId"
                      value={vendorForDocuments ?? ""}
                    />
                    <Select name="documentId" required>
                      <option value="">Pick a document…</option>
                      {openForVendor.map((document) => (
                        <option
                          key={`${document.type}-${document.id}`}
                          value={`${document.type === "workOrder" ? "workOrder" : "expense"}:${document.id}`}
                        >
                          {document.label} ·{" "}
                          {money(document.balanceDue).toFixed(2)}
                        </option>
                      ))}
                    </Select>
                  </>
                )}
                <Button
                  type="submit"
                  disabled={!incoming && openForVendor.length === 0}
                >
                  Create payment
                </Button>
              </form>
              {!incoming ? (
                // A separate GET form: choosing the payee has to reload the
                // panel before their open documents can be listed.
                <form className="mt-3 space-y-2">
                  <input type="hidden" name="account" value={accountId} />
                  <input type="hidden" name="line" value={selected.id} />
                  {showMatched ? (
                    <input type="hidden" name="show" value="matched" />
                  ) : null}
                  <Field
                    label="Paying"
                    hint="Changing this loads what they are owed."
                  >
                    <Select
                      name="payee"
                      defaultValue={vendorForDocuments ?? ""}
                    >
                      {vendors.map((vendor) => (
                        <option key={vendor.id} value={vendor.id}>
                          {vendor.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button variant="secondary" type="submit">
                    Show what they are owed
                  </Button>
                  {openForVendor.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      Nothing outstanding for this payee.
                    </p>
                  ) : null}
                </form>
              ) : null}
            </div>

            <div className="min-w-0 rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                3 · Categorise
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                No document at all — a fee, interest, a small cost.{" "}
                <strong>Posts against the bank.</strong>
              </p>
              <form action={doCategorise} className="mt-3 space-y-2">
                <input type="hidden" name="transactionId" value={selected.id} />
                <Select name="accountId" required>
                  <option value="">Pick an account…</option>
                  {postingAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
                <Field
                  label="Memo"
                  hint="Defaults to the statement's own wording."
                >
                  <Input name="memo" defaultValue={selected.description} />
                </Field>
                <Button type="submit">Post</Button>
              </form>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}
