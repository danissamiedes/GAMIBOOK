import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { failTo } from "@/lib/fail";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { recordExpense, updateExpense } from "@/lib/payables/expenses";
import Link from "next/link";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { money, parseMoney } from "@/lib/money";
import { linkLabel, safeExternalUrl } from "@/lib/links";
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

export const metadata = { title: pageTitle("Expenses and bills") };

/**
 * SPEC §8.2: a direct expense and a bill are two forms sharing one model, not
 * one form with a confusing toggle — a toggle is how a bill gets recorded as
 * already paid.
 */
export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; tab?: string; edit?: string; saved?: string }>;
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
      // Regular vendors only: a consultant's bill belongs to the Consultants
      // section, and this section must not see consultant information at all.
      where: { ...scope.where, OR: [{ vendorId: null }, { vendor: { kind: "REGULAR" } }] },
      include: {
        vendor: { select: { name: true } },
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
        receipt: { select: { id: true } },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 100,
    }),
  ]);

  // The row named by ?edit=. Only an unpaid, unvoided one can be edited, and
  // the service checks that again before it changes anything.
  const editable = (expense: (typeof expenses)[number]) =>
    expense.status !== "VOID" &&
    !expense.applications.some((application) => !application.billPayment.reversedAt);

  const editing = params.edit
    ? (expenses.find((expense) => expense.id === params.edit && editable(expense)) ?? null)
    : null;
  const editKind = editing?.kind ?? null;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const kind = String(formData.get("kind")) === "BILL" ? "BILL" : "DIRECT";
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) failTo(`/expenses?tab=${tab}`, "Enter the amount");

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
        receiptUrl: safeExternalUrl(String(formData.get("fileUrl") || "")),
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
      if (thrown instanceof PostingError) failTo(`/expenses?tab=${tab}`, thrown.message);
      else throw thrown;
    }
    redirect(`/expenses?tab=${kind === "BILL" ? "bill" : "direct"}`);
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const expenseId = String(formData.get("expenseId") || "");
    const back = `/expenses?tab=${tab}&edit=${expenseId}`;
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
        paymentAccountId: String(formData.get("paymentAccountId") || "") || null,
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        description: String(formData.get("description") || "").trim(),
        reference: String(formData.get("reference") || "").trim() || null,
        receiptUrl: safeExternalUrl(String(formData.get("fileUrl") || "")),
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "expense.updated",
        entityType: "Expense",
        entityId: expenseId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      else throw thrown;
    }
    redirect(`/expenses?tab=${tab}&saved=1`);
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
      if (thrown instanceof PostingError) failTo(`/expenses?tab=${tab}`, thrown.message);
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
      {params.saved ? (
        <Alert tone="success">
          Saved. The original entry was reversed and the corrected one posted in
          its place.
        </Alert>
      ) : null}

      <div className="mb-4 flex gap-2">
        <a href="/expenses?tab=direct">
          <Button variant={tab === "direct" ? "primary" : "secondary"}>Direct expenses</Button>
        </a>
        <a href="/expenses?tab=bill">
          <Button variant={tab === "bill" ? "primary" : "secondary"}>Bills</Button>
        </a>
        <a href={`/expenses/export?tab=${tab}`} className="ml-auto">
          <Button variant="secondary">Export to Excel</Button>
        </a>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {rows.length === 0 ? (
            <EmptyState title={tab === "bill" ? "No bills recorded" : "No direct expenses recorded"}>
              {tab === "bill"
                ? "A bill is something you owe and will pay later, so it sits in accounts payable until you do. Record the first one with the form beside this."
                : "A direct expense is paid as you record it — no payable, one entry. Use a bill instead when the money leaves later."}
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Date</th>
                  <th className="py-2">Reference</th>
                  <th className="py-2">Vendor</th>
                  <th className="py-2">Description</th>
                  <th className="py-2 pr-4 text-right">Amount</th>
                  {/* Kept on bills only: without it the list cannot say what is
                      still owed, which is the reason to look at it. */}
                  {tab === "bill" ? <th className="py-2 pr-4 text-right">Balance</th> : null}
                  <th className="py-2">File link</th>
                  <th />
                  {tab === "bill" ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((expense) => (
                  <tr key={expense.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{formatAccountingDate(expense.date)}</td>
                    <td className="py-2 text-slate-500">{expense.reference ?? "—"}</td>
                    <td className="py-2 text-slate-500">{expense.vendor?.name ?? "—"}</td>
                    <td className="py-2">{expense.description}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatMoney(expense.amount.toFixed(2), expense.currency)}
                    </td>
                    {tab === "bill" ? (
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatMoney(expense.balanceDue.toFixed(2), expense.currency)}
                      </td>
                    ) : null}
                    <td className="py-2 text-xs">
                      {safeExternalUrl(expense.receiptUrl) ? (
                        <a
                          className="underline"
                          href={safeExternalUrl(expense.receiptUrl)!}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {linkLabel(safeExternalUrl(expense.receiptUrl)!)}
                        </a>
                      ) : expense.receipt ? (
                        <Link
                          className="underline"
                          href={`/receipts/${expense.receipt.id}/image`}
                          target="_blank"
                        >
                          Photo
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {editable(expense) ? (
                        <Link
                          href={`/expenses?tab=${tab}&edit=${expense.id}`}
                          className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Edit
                        </Link>
                      ) : null}
                    </td>
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
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">
            {editing
              ? `Edit ${editKind === "BILL" ? "bill" : "expense"}`
              : tab === "bill"
                ? "Record a bill"
                : "Record a direct expense"}
          </h2>
          {editing ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              This has already posted. Saving reverses that entry and posts the
              corrected one, dated to the original so the month it belongs to
              stays right.
            </p>
          ) : null}
          <form
            key={editing?.id ?? "new"}
            action={editing ? save : create}
            className="space-y-4"
          >
            <input type="hidden" name="kind" value={tab === "bill" ? "BILL" : "DIRECT"} />
            {editing ? <input type="hidden" name="expenseId" value={editing.id} /> : null}
            {/* Same order as the receipt entry form: what and when, who,
                what it was, what it cost, where it lands, then the currency
                pair. Currency and its rate share a row because both are
                narrow and always read together. */}
            <Field label="Date">
              <Input
                type="date"
                name="date"
                defaultValue={formatAccountingDate(editing?.date ?? today())}
              />
            </Field>
            <Field label="Reference">
              <Input name="reference" defaultValue={editing?.reference ?? ""} />
            </Field>
            <Field label="Vendor" hint={tab === "bill" ? "Required — this is who you owe." : undefined}>
              <Select name="vendorId" defaultValue={editing?.vendorId ?? ""} required={tab === "bill"}>
                <option value="">{tab === "bill" ? "Select…" : "None"}</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
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
            {(editing ? editKind === "BILL" : tab === "bill") ? (
              <Field label="Due date">
                <Input
                  type="date"
                  name="dueDate"
                  defaultValue={editing?.dueDate ? formatAccountingDate(editing.dueDate) : ""}
                />
              </Field>
            ) : (
              <Field label="Paid from">
                <Select
                  name="paymentAccountId"
                  defaultValue={editing?.paymentAccountId ?? paymentAccounts[0]?.id}
                  required
                >
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Currency">
                <Select name="currency" defaultValue={editing?.currency ?? company.baseCurrency}>
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
                <Input
                  name="fxRate"
                  inputMode="decimal"
                  defaultValue={editing ? editing.fxRate.toString() : "1"}
                />
              </Field>
            </div>
            <Field
              label="File link"
              hint="Optional. A Google Drive link, say — it becomes a click-through on the list."
            >
              <Input
                name="fileUrl"
                type="url"
                inputMode="url"
                placeholder="https://drive.google.com/…"
                defaultValue={editing?.receiptUrl ?? ""}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button type="submit">Save</Button>
              {editing ? (
                <Link
                  href={`/expenses?tab=${tab}`}
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
