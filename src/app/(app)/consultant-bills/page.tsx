import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { failTo } from "@/lib/fail";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";

import { recordBillPayment } from "@/lib/payables/bill-payments";
import { money } from "@/lib/money";
import { formatAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { PostingError } from "@/lib/errors";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Select,
} from "@/components/ui";

export const metadata = { title: pageTitle("Consultant bills") };

/**
 * Bills owed to a consultant that are not work orders — a reimbursement, an
 * agreed cost. Structurally the same document as a vendor bill (SPEC §8.2):
 * one Expense with kind = BILL against a CONSULTANT vendor, hitting the same
 * A/P and settled by the same payment machinery. The only difference is which
 * section can see it.
 */
export default async function ConsultantBillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    edit?: string;
    billed?: string;
    failed?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const [paymentAccounts, bills] = await Promise.all([
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    // Only bills against consultants: a regular vendor's bill belongs to the
    // Vendors section and must not appear here.
    prisma.expense.findMany({
      where: { ...scope.where, kind: "BILL", vendor: { kind: "CONSULTANT" } },
      include: {
        vendor: { select: { name: true } },
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
        workOrder: { select: { id: true, workOrderNumber: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
  ]);

  const editable = (bill: (typeof bills)[number]) =>
    bill.status !== "VOID" &&
    !bill.applications.some((application) => !application.billPayment.reversedAt);


  async function pay(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const expenseId = String(formData.get("expenseId"));
    const bill = await prisma.expense.findFirst({
      where: { id: expenseId, ...inner.where, vendor: { kind: "CONSULTANT" } },
    });
    if (!bill?.vendorId) redirect("/consultant-bills");

    try {
      await recordBillPayment({
        companyId: inner.companyId,
        vendorId: bill.vendorId,
        date: today(),
        amount: bill.balanceDue,
        currency: bill.currency,
        fxRate: bill.fxRate,
        paymentAccountId: String(formData.get("paymentAccountId")),
        applications: [{ expenseId: bill.id, amountApplied: bill.balanceDue }],
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo("/consultant-bills", thrown.message);
      else throw thrown;
    }
    redirect("/consultant-bills?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Consultant bills"
        description="Amounts owed to a consultant that aren't work orders — reimbursements and agreed costs."
      />
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.billed ? (
        <Alert tone="success">
          {params.billed} work {params.billed === "1" ? "order" : "orders"} converted to bills.
          They are in accounts payable now and are paid from here.
        </Alert>
      ) : null}
      {params.failed ? (
        <Alert tone="error">{decodeURIComponent(params.failed)}</Alert>
      ) : null}

      <Alert tone="info">
        Work for a consultant starts as a{" "}
        <Link className="underline" href="/work-orders">
          work order
        </Link>
        , which becomes a bill here once it is converted. Record a bill directly for something
        else you owe them — a reimbursement, an agreed cost.
      </Alert>

      <div className="my-4 flex flex-wrap gap-2">
        <Link href="/consultant-bills/new">
          <Button>Record a consultant bill</Button>
        </Link>
        <Link href="/vendor-credits?party=consultant">
          <Button variant="secondary">Credit notes</Button>
        </Link>
      </div>

      <Card>
          {bills.length === 0 ? (
            <EmptyState title="No consultant bills yet">
              A bill is for something you owe a consultant that is not work — a reimbursement, an
              agreed cost. Work itself belongs on a work order. Record the first one with the
              button above.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Date</th>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Description</th>
                  <th className="py-2">Due</th>
                  <th className="py-2 text-right">Amount</th>
                  <th className="py-2 pr-4 text-right">Balance</th>
                  <th />
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr key={bill.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{formatAccountingDate(bill.date)}</td>
                    <td className="py-2">{bill.vendor?.name ?? "—"}</td>
                    <td className="py-2">
                      <Link
                        href={`/expenses/${bill.id}`}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {bill.description}
                      </Link>
                      {bill.workOrder ? (
                        <span className="ml-2 text-xs text-slate-500">
                          from{" "}
                          <Link
                            className="underline"
                            href={`/work-orders/${bill.workOrder.id}`}
                          >
                            {bill.workOrder.workOrderNumber}
                          </Link>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-slate-500">
                      {bill.dueDate ? formatAccountingDate(bill.dueDate) : "—"}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatMoney(bill.amount.toFixed(2), bill.currency)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatMoney(bill.balanceDue.toFixed(2), bill.currency)}
                    </td>
                    <td className="py-2 text-right">
                      {editable(bill) ? (
                        <Link
                          href={`/expenses/${bill.id}/edit`}
                          className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Edit
                        </Link>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      {money(bill.balanceDue).greaterThan(0) && bill.status !== "VOID" ? (
                        <form action={pay} className="flex items-center justify-end gap-2">
                          <input type="hidden" name="expenseId" value={bill.id} />
                          <Select
                            name="paymentAccountId"
                            className="w-36"
                            defaultValue={paymentAccounts[0]?.id}
                          >
                            {paymentAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.code} — {account.name}
                              </option>
                            ))}
                          </Select>
                          <Button variant="secondary" type="submit">
                            Mark paid
                          </Button>
                        </form>
                      ) : (
                        <span className="text-xs text-slate-400">{bill.status.toLowerCase()}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

    </>
  );
}
