import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { VendorKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { withSectionScope } from "@/lib/company-scope";
import {
  recordBillPayment,
  reverseBillPayment,
} from "@/lib/payables/bill-payments";
import { openDocumentsForVendor } from "@/lib/payables/bill-payments";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import { PaymentLines } from "@/components/payment-lines";
import { money, parseMoney, sum } from "@/lib/money";
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

export const metadata = { title: pageTitle("Bill payments") };

/**
 * Paying a consultant and paying a regular vendor are the same act, so they
 * are one screen (SPEC §8.1/§8.2). What differs is who may see which rows:
 * the vendor's `kind` decides that, and the viewer's sections decide which
 * kinds they get. A user holding one side is pinned to it whatever the URL
 * says — the same rule the A/P aging report follows (SPEC §2.1).
 */
export default async function BillPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    vendor?: string;
    kind?: string;
    error?: string;
    saved?: string;
  }>;
}) {
  const scope = await companyScope();
  scope.requireRole("OWNER", "BOOKKEEPER");

  const seesConsultants = scope.hasSection("CONSULTANTS");
  const seesVendors = scope.hasSection("VENDORS");
  if (!seesConsultants && !seesVendors) redirect("/no-access?section=VENDORS");

  const params = await searchParams;
  const requested =
    params.kind === "CONSULTANT" || params.kind === "REGULAR"
      ? params.kind
      : null;
  const kind: VendorKind | null = !seesConsultants
    ? "REGULAR"
    : !seesVendors
      ? "CONSULTANT"
      : (requested as VendorKind | null);
  const canSwitch = seesConsultants && seesVendors;

  /** The kinds this viewer may touch at all, regardless of the filter. */
  const allowedKinds: VendorKind[] = [
    ...(seesConsultants ? (["CONSULTANT"] as const) : []),
    ...(seesVendors ? (["REGULAR"] as const) : []),
  ];

  const [company, payments, vendors, paymentAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.billPayment.findMany({
      where: {
        ...scope.where,
        vendor: { kind: kind ? kind : { in: allowedKinds } },
      },
      include: {
        vendor: { select: { id: true, name: true, kind: true } },
        applications: {
          include: {
            workOrder: { select: { id: true, workOrderNumber: true } },
            expense: { select: { id: true, description: true } },
          },
        },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 200,
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, isActive: true, kind: { in: allowedKinds } },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
      select: { id: true, name: true, kind: true, defaultCurrency: true },
    }),
    prisma.account.findMany({
      where: {
        ...scope.where,
        isActive: true,
        subtype: { in: ["CASH", "CREDIT_CARD"] },
      },
      orderBy: { code: "asc" },
    }),
  ]);

  // The vendor whose open documents are being listed for payment. Checked
  // against the kinds this viewer holds, so ?vendor= cannot reach across the
  // section boundary.
  const selected = params.vendor
    ? (vendors.find((vendor) => vendor.id === params.vendor) ?? null)
    : null;
  const openDocuments = selected
    ? await openDocumentsForVendor(scope.companyId, selected.id)
    : [];

  async function pay(formData: FormData) {
    "use server";
    const inner = await withSectionScope(
      scope.userId,
      scope.companyId,
      formData.get("vendorKind") === "CONSULTANT" ? "CONSULTANTS" : "VENDORS",
    );
    const vendorId = String(formData.get("vendorId"));
    const back = `/bill-payments?vendor=${vendorId}`;

    // Re-prove the vendor is one this user may pay: the form is not the guard.
    const vendor = await prisma.vendor.findFirst({
      where: { id: vendorId, companyId: inner.companyId },
      select: { kind: true, defaultCurrency: true },
    });
    if (!vendor) failTo(back, "Vendor not found");
    const section = vendor!.kind === "CONSULTANT" ? "CONSULTANTS" : "VENDORS";
    if (!inner.hasSection(section))
      failTo("/bill-payments", "You cannot pay that vendor");

    const applications: {
      workOrderId?: string;
      expenseId?: string;
      amountApplied: string;
    }[] = [];
    for (const [field, value] of formData.entries()) {
      const match = /^apply-(workOrder|expense)-(.+)$/.exec(field);
      if (!match) continue;
      const amount = parseMoney(String(value));
      if (!amount || amount.lessThanOrEqualTo(0)) continue;
      applications.push(
        match[1] === "workOrder"
          ? { workOrderId: match[2], amountApplied: amount.toFixed(2) }
          : { expenseId: match[2], amountApplied: amount.toFixed(2) },
      );
    }
    if (applications.length === 0)
      failTo(back, "Enter an amount against at least one document");

    // The payment is the sum of what it settles: an amount typed separately
    // could disagree with the lines, and the service would reject it anyway.
    const total = sum(
      applications.map((application) => money(application.amountApplied)),
    );

    try {
      const { payment } = await recordBillPayment({
        companyId: inner.companyId,
        vendorId,
        date:
          parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        amount: total.toFixed(2),
        currency: String(formData.get("currency") || vendor!.defaultCurrency),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        paymentAccountId: String(formData.get("paymentAccountId")),
        method: String(
          formData.get("method") || "BANK_TRANSFER",
        ) as "BANK_TRANSFER",
        reference: String(formData.get("reference") || "").trim() || null,
        applications,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "billPayment.recorded",
        entityType: "BillPayment",
        entityId: payment.id,
        summary: `${total.toFixed(2)} across ${applications.length} document(s)`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect("/bill-payments?saved=1");
  }

  async function reverse(formData: FormData) {
    "use server";
    const paymentId = String(formData.get("paymentId"));
    const existing = await prisma.billPayment.findFirst({
      where: { id: paymentId, companyId: scope.companyId },
      include: { vendor: { select: { kind: true } } },
    });
    if (!existing) failTo("/bill-payments", "Payment not found");
    const inner = await withSectionScope(
      scope.userId,
      scope.companyId,
      existing!.vendor.kind === "CONSULTANT" ? "CONSULTANTS" : "VENDORS",
    );
    try {
      await reverseBillPayment({
        companyId: inner.companyId,
        billPaymentId: paymentId,
        // Reversed today, not on the original date: the correction is its own
        // event, and back-dating it would move a closed period.
        date: today(),
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "billPayment.reversed",
        entityType: "BillPayment",
        entityId: paymentId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError)
        failTo("/bill-payments", thrown.message);
      throw thrown;
    }
    redirect("/bill-payments?saved=1");
  }

  const scopeNote = !canSwitch
    ? seesConsultants
      ? "Consultants only — your access does not include regular vendors."
      : "Regular vendors only — your access does not include consultants."
    : null;

  return (
    <>
      <PageHeader
        title="Bill payments"
        description={`Money out to consultants and vendors. ${company.baseCurrency} books · reversal deletes nothing.`}
      />

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {scopeNote ? <Alert tone="info">{scopeNote}</Alert> : null}

      {canSwitch ? (
        <div className="mb-4 mt-4 flex flex-wrap gap-2">
          {[
            { value: "", label: "All payees" },
            { value: "CONSULTANT", label: "Consultants" },
            { value: "REGULAR", label: "Regular vendors" },
          ].map((option) => (
            <Link
              key={option.label}
              href={`/bill-payments${option.value ? `?kind=${option.value}` : ""}`}
            >
              <Button
                variant={
                  (kind ?? "") === option.value ? "primary" : "secondary"
                }
              >
                {option.label}
              </Button>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Payments made</h2>
          {payments.length === 0 ? (
            <EmptyState title="No payments recorded yet">
              Pay a consultant or a vendor with the form beside this, or from
              the work order or bill itself. Every payment lands here whichever
              way it was made.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Date</th>
                  <th className="py-2">Paid to</th>
                  <th className="py-2">Settled</th>
                  <th className="py-2">Method</th>
                  <th className="py-2 text-right">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr
                    key={payment.id}
                    className="border-b border-slate-100 dark:border-slate-800/60"
                  >
                    <td className="py-2">
                      {formatAccountingDate(payment.date)}
                    </td>
                    <td className="py-2">
                      {payment.vendor.name}
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">
                        {payment.vendor.kind === "CONSULTANT"
                          ? "consultant"
                          : "vendor"}
                      </span>
                      {payment.reversedAt ? (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-red-800 dark:bg-red-950 dark:text-red-200">
                          reversed
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-xs text-slate-500">
                      {payment.applications.map((application, index) => (
                        <span key={application.id}>
                          {index > 0 ? " · " : ""}
                          {application.workOrder ? (
                            <Link
                              className="underline"
                              href={`/work-orders/${application.workOrder.id}`}
                            >
                              {application.workOrder.workOrderNumber ?? "draft"}
                            </Link>
                          ) : (
                            (application.expense?.description ?? "bill")
                          )}{" "}
                          {money(application.amountApplied).toFixed(2)}
                        </span>
                      ))}
                    </td>
                    <td className="py-2 text-xs">
                      {payment.method.toLowerCase().replace("_", " ")}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(
                        money(payment.amount).toFixed(2),
                        payment.currency,
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {payment.reversedAt ? null : (
                        <form action={reverse}>
                          <input
                            type="hidden"
                            name="paymentId"
                            value={payment.id}
                          />
                          <Button variant="ghost" type="submit">
                            Reverse
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Record a payment</h2>

          {/* Choosing the payee reloads with their open documents: one bank
              transfer usually settles several of them at once. */}
          <form className="mb-4">
            {canSwitch && kind ? (
              <input type="hidden" name="kind" value={kind} />
            ) : null}
            <Field label="Payee">
              <Select name="vendor" defaultValue={selected?.id ?? ""}>
                <option value="">Select…</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name} (
                    {vendor.kind === "CONSULTANT" ? "consultant" : "vendor"})
                  </option>
                ))}
              </Select>
            </Field>
            <Button className="mt-2" variant="secondary" type="submit">
              Show what is open
            </Button>
          </form>

          {selected === null ? (
            <p className="text-sm text-slate-500">
              Pick a payee to see what they are owed.
            </p>
          ) : openDocuments.length === 0 ? (
            <Alert tone="info">{selected.name} has nothing outstanding.</Alert>
          ) : (
            <form action={pay} className="space-y-3">
              <input type="hidden" name="vendorId" value={selected.id} />
              <input type="hidden" name="vendorKind" value={selected.kind} />
              <input
                type="hidden"
                name="currency"
                value={openDocuments[0].currency}
              />

              <PaymentLines
                currency={openDocuments[0].currency}
                lines={openDocuments.map((document) => ({
                  name: `apply-${document.type}-${document.id}`,
                  label: document.label,
                  dueLabel: `due ${formatAccountingDate(document.dueDate)}`,
                  owing: money(document.balanceDue).toFixed(2),
                  currency: document.currency,
                  defaultAmount: money(document.balanceDue).toFixed(2),
                }))}
              />

              {/* Everything open is in one currency, because the service will
                  not settle a document in a currency other than its own. */}
              {new Set(openDocuments.map((document) => document.currency))
                .size > 1 ? (
                <Alert tone="warning">
                  {selected.name} has documents in more than one currency. Pay
                  one currency at a time — clear the amounts on the others.
                </Alert>
              ) : null}

              <Field label="Date">
                <Input
                  type="date"
                  name="date"
                  defaultValue={formatAccountingDate(today())}
                />
              </Field>
              <Field label="Paid from">
                <Select
                  name="paymentAccountId"
                  defaultValue={paymentAccounts[0]?.id}
                >
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Method">
                <Select name="method" defaultValue="BANK_TRANSFER">
                  {["BANK_TRANSFER", "CHECK", "CASH", "OTHER"].map((method) => (
                    <option key={method} value={method}>
                      {method.toLowerCase().replace("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Reference"
                hint="Cheque number, transfer reference — optional."
              >
                <Input name="reference" />
              </Field>
              {openDocuments[0].currency !== company.baseCurrency ? (
                <Field
                  label={`Rate (1 ${openDocuments[0].currency} in ${company.baseCurrency})`}
                  hint="The rate on the day the money moved."
                >
                  <Input name="fxRate" inputMode="decimal" defaultValue="1" />
                </Field>
              ) : null}
              <Button type="submit">Record payment</Button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
