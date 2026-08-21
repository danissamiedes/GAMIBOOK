import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { SUPPORTED_CURRENCIES, formatMoney, isSupportedCurrency } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Consultants — Ledger" };

/**
 * Consultants are vendors with kind = CONSULTANT (SPEC §6). The filter is in
 * the query, so a user in this section never sees a regular vendor and vice
 * versa — that is the separation the user asked for, not a hidden tab.
 */
export default async function ConsultantsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { error } = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [consultants, expenseAccounts] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT" },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        workOrders: {
          where: { status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
          select: { balanceDue: true, fxRate: true },
        },
        user: { select: { email: true } },
      },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
    }),
  ]);

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const name = String(formData.get("name") || "").trim();
    const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
    if (!name) redirect("/consultants?error=name");
    if (!isSupportedCurrency(currency)) redirect("/consultants?error=currency");

    const email = String(formData.get("email") || "").trim() || null;
    const sendEmails = formData.get("sendEmails") === "on";
    if (sendEmails && !email) redirect("/consultants?error=email");

    const vendor = await prisma.vendor.create({
      data: {
        companyId: inner.companyId,
        kind: "CONSULTANT",
        name,
        email,
        defaultCurrency: currency,
        defaultRate: String(formData.get("defaultRate") || "").trim() || null,
        defaultAccountId: String(formData.get("defaultAccountId") || "") || null,
        paymentTermsDays: Number(formData.get("paymentTermsDays") || 15),
        sendEmails,
        ccEmails: String(formData.get("ccEmails") || "")
          .split(/[,;\s]+/)
          .map((address) => address.trim())
          .filter(Boolean),
        externalRef: String(formData.get("externalRef") || "").trim() || null,
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "consultant.created",
      entityType: "Vendor",
      entityId: vendor.id,
      summary: name,
    });
    redirect("/consultants");
  }

  return (
    <>
      <PageHeader
        title="Consultants"
        description="Who you raise work orders for. Their email setup here is what the bulk send uses."
      />
      {error === "email" ? (
        <Alert tone="error">
          A consultant set to receive emails needs an address. Untick the box, or add one.
        </Alert>
      ) : null}
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {consultants.length === 0 ? (
            <EmptyState title="No consultants yet">Add the first one on the right.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Work orders go to</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {consultants.map((consultant) => {
                  const owed = sum(
                    consultant.workOrders.map((workOrder) =>
                      money(workOrder.balanceDue).times(money(workOrder.fxRate)),
                    ),
                  );
                  const recipients = consultant.sendEmails
                    ? [consultant.email, ...consultant.ccEmails].filter(Boolean).join(", ")
                    : null;
                  return (
                    <tr key={consultant.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">
                        <span className={consultant.isActive ? "" : "text-slate-400 line-through"}>
                          {consultant.name}
                        </span>
                        {consultant.user ? (
                          <div className="text-xs text-slate-500">
                            clocks in as {consultant.user.email}
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2 text-xs text-slate-600 dark:text-slate-400">
                        {recipients ?? <span className="text-amber-600">not emailed</span>}
                      </td>
                      <td className="py-2">{consultant.defaultCurrency}</td>
                      <td className="py-2 text-right tabular-nums">
                        {consultant.defaultRate ? consultant.defaultRate.toFixed(2) : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {owed.isZero() ? "—" : formatMoney(owed.toFixed(2), company.baseCurrency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Add a consultant</h2>
          <form action={create} className="space-y-4">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" />
            </Field>
            <Field label="Cc" hint="Comma separated — a manager or agency contact.">
              <Input name="ccEmails" />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="sendEmails" defaultChecked />
              Include in work order emails
            </label>
            <Field label="Currency">
              <Select name="defaultCurrency" defaultValue="PHP">
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default rate">
              <Input name="defaultRate" inputMode="decimal" />
            </Field>
            <Field label="Default expense account">
              <Select name="defaultAccountId" defaultValue="">
                <option value="">None</option>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment terms (days)">
              <Input name="paymentTermsDays" type="number" defaultValue={15} min={0} />
            </Field>
            <Field
              label="Spreadsheet code"
              hint="Optional. Helps the import match this person when a sheet names them differently."
            >
              <Input name="externalRef" />
            </Field>
            <Button type="submit">Add consultant</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
