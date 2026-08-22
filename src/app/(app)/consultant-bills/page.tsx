import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { failTo } from "@/lib/fail";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { recordExpense, updateExpense } from "@/lib/payables/expenses";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { PostingError } from "@/lib/errors";
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
  searchParams: Promise<{ error?: string; saved?: string; edit?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const [company, consultants, expenseAccounts, paymentAccounts, bills] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
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
    // Only bills against consultants: a regular vendor's bill belongs to the
    // Vendors section and must not appear here.
    prisma.expense.findMany({
      where: { ...scope.where, kind: "BILL", vendor: { kind: "CONSULTANT" } },
      include: {
        vendor: { select: { name: true } },
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
  ]);

  const editable = (bill: (typeof bills)[number]) =>
    bill.status !== "VOID" &&
    !bill.applications.some((application) => !application.billPayment.reversedAt);

  const editing = params.edit
    ? (bills.find((bill) => bill.id === params.edit && editable(bill)) ?? null)
    : null;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) failTo("/consultant-bills", "Enter the amount");

    const vendorId = String(formData.get("vendorId") || "");
    const consultant = await prisma.vendor.findFirst({
      where: { id: vendorId, ...inner.where, kind: "CONSULTANT" },
    });
    if (!consultant) failTo("/consultant-bills", "Pick a consultant");

    try {
      const result = await recordExpense({
        companyId: inner.companyId,
        kind: "BILL",
        vendorId: consultant!.id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        currency: String(formData.get("currency") || "").toUpperCase(),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        amount: amount!,
        expenseAccountId: String(formData.get("expenseAccountId")),
        description: String(formData.get("description") || "").trim(),
        reference: String(formData.get("reference") || "").trim() || null,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "consultant_bill.recorded",
        entityType: "Expense",
        entityId: result.expense.id,
        summary: `${amount!.toFixed(2)} to ${consultant!.name}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo("/consultant-bills", thrown.message);
      else throw thrown;
    }
    redirect("/consultant-bills?saved=1");
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const expenseId = String(formData.get("expenseId") || "");
    const back = `/consultant-bills?edit=${expenseId}`;
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) failTo(back, "Enter the amount");

    try {
      await updateExpense({
        companyId: inner.companyId,
        expenseId,
        vendorId: String(formData.get("vendorId") || "") || null,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        currency: String(formData.get("currency") || "").toUpperCase(),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        amount: amount!,
        expenseAccountId: String(formData.get("expenseAccountId")),
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        description: String(formData.get("description") || "").trim(),
        reference: String(formData.get("reference") || "").trim() || null,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "bill.updated",
        entityType: "Expense",
        entityId: expenseId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      else throw thrown;
    }
    redirect("/consultant-bills?saved=1");
  }

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

      <Alert tone="info">
        Work for a consultant belongs on a{" "}
        <Link className="underline" href="/work-orders">
          work order
        </Link>
        . Use a bill for something else you owe them. Both hit accounts payable and both are
        settled the same way.
      </Alert>

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {bills.length === 0 ? (
            <EmptyState title="No consultant bills yet">
              A bill is for something you owe a consultant that is not work — a reimbursement, an
              agreed cost. Work itself belongs on a work order. Record the first one using the form
              beside this.
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
                  <th className="py-2 text-right">Balance</th>
                  <th />
                  <th />
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr key={bill.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{formatAccountingDate(bill.date)}</td>
                    <td className="py-2">{bill.vendor?.name ?? "—"}</td>
                    <td className="py-2">{bill.description}</td>
                    <td className="py-2 text-slate-500">
                      {bill.dueDate ? formatAccountingDate(bill.dueDate) : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(bill.amount.toFixed(2), bill.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(bill.balanceDue.toFixed(2), bill.currency)}
                    </td>
                    <td className="py-2 text-right">
                      {editable(bill) ? (
                        <Link
                          href={`/consultant-bills?edit=${bill.id}`}
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

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">
            {editing ? `Edit ${editing.description}` : "Record a consultant bill"}
          </h2>
          {editing ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              This has already posted. Saving reverses that entry and posts the
              corrected one, dated to the original.
            </p>
          ) : null}
          <form
            key={editing?.id ?? "new"}
            action={editing ? save : create}
            className="space-y-4"
          >
            {editing ? <input type="hidden" name="expenseId" value={editing.id} /> : null}
            <Field label="Date">
              <Input
                type="date"
                name="date"
                defaultValue={formatAccountingDate(editing?.date ?? today())}
              />
            </Field>
            <Field label="Consultant">
              <Select name="vendorId" defaultValue={editing?.vendorId ?? consultants[0]?.id} required>
                {consultants.map((consultant) => (
                  <option key={consultant.id} value={consultant.id}>
                    {consultant.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Description">
              <Input name="description" required defaultValue={editing?.description ?? ""} />
            </Field>
            <Field label="Amount">
              <Input
                name="amount"
                inputMode="decimal"
                required
                defaultValue={editing ? editing.amount.toFixed(2) : ""}
              />
            </Field>
            <Field label="Currency">
              <Select
                name="currency"
                defaultValue={
                  editing?.currency ?? consultants[0]?.defaultCurrency ?? company.baseCurrency
                }
              >
                {[...new Set([company.baseCurrency, ...consultants.map((c) => c.defaultCurrency)])].map(
                  (currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
              <Input
                name="fxRate"
                inputMode="decimal"
                defaultValue={editing ? editing.fxRate.toString() : "1"}
              />
            </Field>
            <Field label="Expense account">
              <Select
                name="expenseAccountId"
                defaultValue={editing?.expenseAccountId ?? expenseAccounts[0]?.id}
                required
              >
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                name="dueDate"
                defaultValue={editing?.dueDate ? formatAccountingDate(editing.dueDate) : ""}
              />
            </Field>
            <Field label="Reference">
              <Input name="reference" defaultValue={editing?.reference ?? ""} />
            </Field>
            <div className="flex items-center gap-2">
              <Button type="submit">{editing ? "Save changes" : "Record bill"}</Button>
              {editing ? (
                <Link
                  href="/consultant-bills"
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </Link>
              ) : null}
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
