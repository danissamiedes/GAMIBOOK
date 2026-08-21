import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { recordExpense } from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { PostingError } from "@/lib/errors";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Expenses and bills — Ledger" };

/**
 * SPEC §8.2: a direct expense and a bill are two forms sharing one model, not
 * one form with a confusing toggle — a toggle is how a bill gets recorded as
 * already paid.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; tab?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;
  const tab = params.tab === "bill" ? "bill" : "direct";

  const [company, vendors, expenseAccounts, paymentAccounts, expenses] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR", isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
    prisma.expense.findMany({
      where: scope.where,
      include: { vendor: { select: { name: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
  ]);

  const fail = (message: string) =>
    redirect(`/expenses?tab=${tab}&error=${encodeURIComponent(message)}`);

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const kind = String(formData.get("kind")) === "BILL" ? "BILL" : "DIRECT";
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) fail("Enter the amount");

    try {
      const result = await recordExpense({
        companyId: inner.companyId,
        kind,
        vendorId: String(formData.get("vendorId") || "") || null,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        currency: String(formData.get("currency") || "").toUpperCase(),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        amount: amount!,
        expenseAccountId: String(formData.get("expenseAccountId")),
        paymentAccountId: kind === "DIRECT" ? String(formData.get("paymentAccountId")) : null,
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        description: String(formData.get("description") || "").trim(),
        reference: String(formData.get("reference") || "").trim() || null,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: kind === "DIRECT" ? "expense.recorded" : "bill.recorded",
        entityType: "Expense",
        entityId: result.expense.id,
        summary: `${amount!.toFixed(2)} — ${String(formData.get("description") || "")}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) fail(thrown.message);
      else throw thrown;
    }
    redirect(`/expenses?tab=${kind === "BILL" ? "bill" : "direct"}`);
  }

  async function payBill(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const expenseId = String(formData.get("expenseId"));
    const bill = await prisma.expense.findFirst({ where: { id: expenseId, ...inner.where } });
    if (!bill?.vendorId) redirect("/expenses?tab=bill");

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
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bill.paid",
        entityType: "Expense",
        entityId: bill.id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) fail(thrown.message);
      else throw thrown;
    }
    redirect("/expenses?tab=bill");
  }

  const bills = expenses.filter((expense) => expense.kind === "BILL");
  const direct = expenses.filter((expense) => expense.kind === "DIRECT");
  const rows = tab === "bill" ? bills : direct;

  return (
    <>
      <PageHeader
        title="Expenses and bills"
        description="A direct expense is paid as you record it. A bill is owed and cleared later."
      />
      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      <div className="mb-4 flex gap-2">
        <a href="/expenses?tab=direct">
          <Button variant={tab === "direct" ? "primary" : "secondary"}>Direct expenses</Button>
        </a>
        <a href="/expenses?tab=bill">
          <Button variant={tab === "bill" ? "primary" : "secondary"}>Bills</Button>
        </a>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {rows.length === 0 ? (
            <EmptyState title={tab === "bill" ? "No bills recorded" : "No direct expenses recorded"} />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Date</th>
                  <th className="py-2">Description</th>
                  <th className="py-2">Vendor</th>
                  <th className="py-2 text-right">Amount</th>
                  {tab === "bill" ? <th className="py-2 text-right">Balance</th> : null}
                  {tab === "bill" ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((expense) => (
                  <tr key={expense.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{formatAccountingDate(expense.date)}</td>
                    <td className="py-2">{expense.description}</td>
                    <td className="py-2 text-slate-500">{expense.vendor?.name ?? "—"}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(expense.amount.toFixed(2), expense.currency)}
                    </td>
                    {tab === "bill" ? (
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(expense.balanceDue.toFixed(2), expense.currency)}
                      </td>
                    ) : null}
                    {tab === "bill" ? (
                      <td className="py-2 text-right">
                        {money(expense.balanceDue).greaterThan(0) && expense.status !== "VOID" ? (
                          <form action={payBill} className="flex items-center justify-end gap-2">
                            <input type="hidden" name="expenseId" value={expense.id} />
                            <Select name="paymentAccountId" className="w-40" defaultValue={paymentAccounts[0]?.id}>
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
                          <span className="text-xs text-slate-400">
                            {expense.status.toLowerCase()}
                          </span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">
            {tab === "bill" ? "Record a bill" : "Record a direct expense"}
          </h2>
          <form action={create} className="space-y-4">
            <input type="hidden" name="kind" value={tab === "bill" ? "BILL" : "DIRECT"} />
            <Field label="Date">
              <Input type="date" name="date" defaultValue={formatAccountingDate(today())} />
            </Field>
            <Field label="Description">
              <Input name="description" required />
            </Field>
            <Field label="Vendor" hint={tab === "bill" ? "Required — this is who you owe." : undefined}>
              <Select name="vendorId" defaultValue="" required={tab === "bill"}>
                <option value="">{tab === "bill" ? "Select…" : "None"}</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <Input name="amount" inputMode="decimal" required />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={company.baseCurrency}>
                {[...new Set([company.baseCurrency, ...vendors.map((v) => v.defaultCurrency)])].map(
                  (currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
              <Input name="fxRate" inputMode="decimal" defaultValue="1" />
            </Field>
            <Field label="Expense account">
              <Select name="expenseAccountId" defaultValue={expenseAccounts[0]?.id} required>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            {tab === "bill" ? (
              <Field label="Due date">
                <Input type="date" name="dueDate" />
              </Field>
            ) : (
              <Field label="Paid from">
                <Select name="paymentAccountId" defaultValue={paymentAccounts[0]?.id} required>
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Reference">
              <Input name="reference" />
            </Field>
            <Button type="submit">{tab === "bill" ? "Record bill" : "Record expense"}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
