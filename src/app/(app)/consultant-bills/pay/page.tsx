import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import {
  MAX_BULK_PAYMENTS,
  payableConsultantDocuments,
  planBulkPay,
  recordBulkPay,
  type BulkPayLine,
  type PayableKind,
} from "@/lib/payables/bulk-pay";
import { PostingError } from "@/lib/errors";
import { formatAccountingDate, isoDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
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
} from "@/components/ui";

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
 */
export default async function PayConsultantBillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    consultant?: string;
    from?: string;
    to?: string;
    selected?: string | string[];
    amount?: string | string[];
    date?: string;
    paymentAccountId?: string;
    reference?: string;
    confirm?: string;
    error?: string;
    paid?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const asList = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value : value ? [value] : [];

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

  /**
   * A ticked row travels as `kind:id`, so one parameter carries both which
   * table it is in and which row. The amounts ride alongside in the order the
   * boxes were shown — unticking a row leaves its amount box behind, which is
   * why the two are matched by position rather than by name.
   */
  const selected = asList(params.selected);
  const amounts = asList(params.amount);
  const lines: BulkPayLine[] = selected.map((token, index) => {
    const [kind, documentId] = token.split(":");
    return {
      kind: (kind === "workOrder" ? "workOrder" : "bill") as PayableKind,
      documentId: documentId ?? "",
      amount: amounts[index] ?? "0",
    };
  });

  const plan =
    params.confirm === "1" && lines.length > 0
      ? await planBulkPay({ companyId: scope.companyId, lines }).catch(() => null)
      : null;

  async function pay(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");

    const tokens = formData.getAll("document").map(String);
    const values = formData.getAll("amount").map(String);
    const paying: BulkPayLine[] = tokens.map((token, index) => {
      const [kind, documentId] = token.split(":");
      return {
        kind: (kind === "workOrder" ? "workOrder" : "bill") as PayableKind,
        documentId: documentId ?? "",
        amount: values[index] ?? "0",
      };
    });

    try {
      const result = await recordBulkPay({
        companyId: inner.companyId,
        lines: paying,
        date: new Date(`${String(formData.get("date"))}T00:00:00Z`),
        paymentAccountId: String(formData.get("paymentAccountId")),
        reference: String(formData.get("reference") ?? "").trim() || null,
        userId: inner.userId,
        role: inner.role,
      });

      const note =
        result.failed.length > 0
          ? `${result.paid.length} paid. Could not pay: ${result.failed
              .map((entry) => `${entry.consultantName} — ${entry.reason}`)
              .join("; ")}`
          : `${result.paid.length} consultant${result.paid.length === 1 ? "" : "s"} paid.`;
      redirect(`/consultant-bills/pay?paid=${encodeURIComponent(note)}`);
    } catch (error) {
      if (error instanceof PostingError) {
        redirect(`/consultant-bills/pay?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
  }

  const legacyCount = documents.filter((document) => document.kind === "workOrder").length;

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

      {params.error ? <Alert tone="error">{decodeURIComponent(params.error)}</Alert> : null}
      {params.paid ? <Alert tone="success">{decodeURIComponent(params.paid)}</Alert> : null}

      {plan ? (
        <Card className="mb-4">
          <h2 className="mb-1 text-sm font-semibold">
            {plan.payable.length} payment{plan.payable.length === 1 ? "" : "s"} to record
          </h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            One per consultant.{" "}
            {plan.currency ? (
              <>Total {formatMoney(money(plan.total).toFixed(2), plan.currency)}.</>
            ) : (
              <>The selection spans more than one currency, so there is no single total.</>
            )}
          </p>

          {plan.excluded.length > 0 ? (
            <Alert tone="warning">
              <strong>
                {plan.excluded.length} consultant{plan.excluded.length === 1 ? "" : "s"} left out:
              </strong>
              <ul className="ml-4 mt-1 list-disc">
                {plan.excluded.map((payment) => (
                  <li key={payment.vendorId}>{payment.excludedReason}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <form action={pay} className="mt-3 space-y-3">
            <DataTable>
              <thead className="border-b border-slate-200 text-left dark:border-slate-700">
                <tr>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Settles</th>
                  <th className="py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {plan.payable.map((payment) => (
                  <tr
                    key={payment.vendorId}
                    className="border-b border-slate-100 dark:border-slate-800"
                  >
                    <td className="py-2">{payment.consultantName}</td>
                    <td className="py-2">{payment.lines.map((line) => line.label).join(", ")}</td>
                    <td className="py-2 text-right">
                      {formatMoney(money(payment.total).toFixed(2), payment.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            {plan.payable.flatMap((payment) =>
              payment.lines.map((line) => (
                <div key={`${line.kind}:${line.documentId}`}>
                  <input
                    type="hidden"
                    name="document"
                    value={`${line.kind}:${line.documentId}`}
                  />
                  <input type="hidden" name="amount" value={money(line.amount).toFixed(2)} />
                </div>
              )),
            )}

            <div className="flex flex-wrap gap-3">
              <Field label="Payment date">
                <Input type="date" name="date" defaultValue={isoDate(today())} required />
              </Field>
              <Field label="Paid from">
                <Select name="paymentAccountId" defaultValue={paymentAccounts[0]?.id} required>
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reference" hint="Optional — the same on every payment in this run.">
                <Input name="reference" placeholder="e.g. Payroll 28 Aug" />
              </Field>
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={plan.payable.length === 0}>
                Record {plan.payable.length} payment{plan.payable.length === 1 ? "" : "s"}
              </Button>
            </div>
          </form>
        </Card>
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
          <form method="get" action="/consultant-bills/pay" className="space-y-3">
            <input type="hidden" name="confirm" value="1" />
            {params.consultant ? (
              <input type="hidden" name="consultant" value={params.consultant} />
            ) : null}
            {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
            {params.to ? <input type="hidden" name="to" value={params.to} /> : null}

            <DataTable>
              <thead className="border-b border-slate-200 text-left dark:border-slate-700">
                <tr>
                  <th className="w-8 py-2" />
                  <th className="py-2">Document</th>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Dated</th>
                  <th className="py-2">Due</th>
                  <th className="py-2 text-right">Outstanding</th>
                  <th className="py-2 text-right">Paying</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr
                    key={`${document.kind}:${document.id}`}
                    className="border-b border-slate-100 dark:border-slate-800"
                  >
                    <td className="py-2">
                      <input
                        type="checkbox"
                        name="selected"
                        value={`${document.kind}:${document.id}`}
                        defaultChecked
                        aria-label={`Pay ${document.label}`}
                        className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-600"
                      />
                    </td>
                    <td className="py-2">
                      <Link
                        className="underline decoration-dotted underline-offset-2"
                        href={
                          document.kind === "bill"
                            ? `/expenses/${document.id}`
                            : `/work-orders/${document.id}`
                        }
                      >
                        {document.label}
                      </Link>
                      {document.kind === "workOrder" ? (
                        // Said on the row rather than in a note nobody reads:
                        // these are the ones that posted on approval, and a
                        // reader needs to know why a work order is here at all.
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          work order
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">{document.consultantName}</td>
                    <td className="py-2">{formatAccountingDate(document.date)}</td>
                    <td className="py-2 text-slate-500">
                      {document.dueDate ? formatAccountingDate(document.dueDate) : "—"}
                    </td>
                    <td className="py-2 text-right">
                      {formatMoney(money(document.balanceDue).toFixed(2), document.currency)}
                    </td>
                    <td className="py-2 text-right">
                      {/* Defaults to the whole balance; type less to part-pay.
                          Unticking the row leaves this box behind, which is
                          why the service matches rows to amounts by position.

                          The width lives on the wrapper, not on the Input:
                          `Input` carries w-full in its own base classes, and
                          two width utilities on one element are settled by
                          stylesheet order rather than by which was written
                          last — so a w-28 here loses and the box stretches
                          across the column beside it. */}
                      <div className="ml-auto w-28">
                        <Input
                          name="amount"
                          inputMode="decimal"
                          defaultValue={money(document.balanceDue).toFixed(2)}
                          aria-label={`Amount for ${document.label}`}
                          className="text-right"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            <Button type="submit">Review payments</Button>
            <p className="text-xs text-slate-500">
              Up to {MAX_BULK_PAYMENTS} consultants in one run. Books are {company.baseCurrency};
              each document is paid in its own currency.
              {legacyCount > 0
                ? ` ${legacyCount} work order${
                    legacyCount === 1 ? "" : "s"
                  } raised under the earlier flow ${
                    legacyCount === 1 ? "is" : "are"
                  } listed too — those posted on approval and are paid directly.`
                : ""}
            </p>
          </form>
        </Card>
      )}
    </>
  );
}
