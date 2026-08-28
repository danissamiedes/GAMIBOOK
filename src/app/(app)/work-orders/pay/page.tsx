import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import {
  payableWorkOrders,
  planBulkPay,
  recordBulkPay,
  MAX_BULK_PAYMENTS,
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

export const metadata = { title: pageTitle("Pay work orders") };

/**
 * Paying many work orders at once (SPEC §6).
 *
 * Tick what is being paid, set one date and one account, confirm. The list is
 * what is actually outstanding — approved or part-paid with a balance — so a
 * work order that is already settled cannot be paid twice by being on screen.
 *
 * The confirm step is not ceremony. It is where the selection stops being a
 * list of documents and becomes a list of *payments*, one per consultant, and
 * seeing that before posting is the difference between a run you can check and
 * eighteen postings you have to unpick.
 */
export default async function BulkPayPage({
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
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const selectedIds = Array.isArray(params.selected)
    ? params.selected
    : params.selected
      ? [params.selected]
      : [];

  const [company, consultants, paymentAccounts, workOrders] = await Promise.all([
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
    payableWorkOrders({
      companyId: scope.companyId,
      consultantId: params.consultant || null,
      from: params.from ? new Date(`${params.from}T00:00:00Z`) : null,
      to: params.to ? new Date(`${params.to}T00:00:00Z`) : null,
    }),
  ]);

  // Amounts travel alongside the ids, in the same order the boxes were shown.
  const amounts = Array.isArray(params.amount)
    ? params.amount
    : params.amount
      ? [params.amount]
      : [];
  const lines = selectedIds.map((workOrderId, index) => ({
    workOrderId,
    amount: amounts[index] ?? "0",
  }));

  const plan =
    params.confirm === "1" && lines.length > 0
      ? await planBulkPay({ companyId: scope.companyId, lines }).catch(() => null)
      : null;

  async function pay(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");

    const ids = formData.getAll("workOrderId").map(String);
    const values = formData.getAll("amount").map(String);
    const paid = ids.map((workOrderId, index) => ({
      workOrderId,
      amount: values[index] ?? "0",
    }));

    try {
      const result = await recordBulkPay({
        companyId: inner.companyId,
        lines: paid,
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
          : `${result.paid.length} consultant(s) paid.`;
      redirect(`/work-orders/pay?error=${encodeURIComponent(note)}`);
    } catch (error) {
      if (error instanceof PostingError) {
        redirect(`/work-orders/pay?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
  }

  return (
    <>
      <PageHeader
        title="Pay work orders"
        description="Tick what is being paid and settle it in one go. Each consultant gets their own payment, all on the date and account you choose here."
      />

      {params.error ? <Alert tone="info">{decodeURIComponent(params.error)}</Alert> : null}

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
                  <th className="py-2">Work orders</th>
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
                    <td className="py-2">
                      {payment.lines.map((line) => line.number).join(", ")}
                    </td>
                    <td className="py-2 text-right">
                      {formatMoney(money(payment.total).toFixed(2), payment.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>

            {plan.payable.flatMap((payment) =>
              payment.lines.map((line) => (
                <div key={line.workOrderId}>
                  <input type="hidden" name="workOrderId" value={line.workOrderId} />
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
          <Field label="Issued from">
            <Input type="date" name="from" defaultValue={params.from ?? ""} />
          </Field>
          <Field label="Issued to">
            <Input type="date" name="to" defaultValue={params.to ?? ""} />
          </Field>
          <Button variant="secondary" type="submit">
            Filter
          </Button>
        </form>
      </Card>

      {workOrders.length === 0 ? (
        <EmptyState title="Nothing outstanding">
          Every approved work order matching this filter has been paid.
        </EmptyState>
      ) : (
        <Card>
          <form method="get" action="/work-orders/pay" className="space-y-3">
            <input type="hidden" name="confirm" value="1" />
            {params.consultant ? (
              <input type="hidden" name="consultant" value={params.consultant} />
            ) : null}
            {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
            {params.to ? <input type="hidden" name="to" value={params.to} /> : null}

            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 text-left dark:border-slate-700">
                <tr>
                  <th className="w-8 py-2" />
                  <th className="py-2">Work order</th>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Issued</th>
                  <th className="py-2 text-right">Outstanding</th>
                  <th className="py-2 text-right">Paying</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((workOrder) => (
                  <tr key={workOrder.id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        name="selected"
                        value={workOrder.id}
                        defaultChecked
                        aria-label={`Pay ${workOrder.workOrderNumber ?? "work order"}`}
                        className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-600"
                      />
                    </td>
                    <td className="py-2">{workOrder.workOrderNumber ?? "—"}</td>
                    <td className="py-2">{workOrder.vendor.name}</td>
                    <td className="py-2">{formatAccountingDate(workOrder.issueDate)}</td>
                    <td className="py-2 text-right">
                      {formatMoney(money(workOrder.balanceDue).toFixed(2), workOrder.currency)}
                    </td>
                    <td className="py-2 text-right">
                      {/* Defaults to the whole balance; type less to part-pay.
                          Unticking the row leaves this box behind, which is
                          why the service matches ids to amounts by position. */}
                      <Input
                        name="amount"
                        inputMode="decimal"
                        defaultValue={money(workOrder.balanceDue).toFixed(2)}
                        aria-label={`Amount for ${workOrder.workOrderNumber ?? "work order"}`}
                        className="w-28 text-right"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <Button type="submit">Review payments</Button>
            <p className="text-xs text-slate-500">
              Up to {MAX_BULK_PAYMENTS} consultants in one run. Books are {company.baseCurrency};
              each work order is paid in its own currency.
            </p>
          </form>
        </Card>
      )}
    </>
  );
}
