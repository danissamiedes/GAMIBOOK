import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { SUPPORTED_CURRENCIES, formatMoney, isSupportedCurrency } from "@/lib/currency";
import { money, sum } from "@/lib/money";
import { PartyError, updateVendor } from "@/lib/parties";
import Link from "next/link";
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

export const metadata = { title: pageTitle("Consultants") };

/**
 * Consultants are vendors with kind = CONSULTANT (SPEC §6). The filter is in
 * the query, so a user in this section never sees a regular vendor and vice
 * versa — that is the separation the user asked for, not a hidden tab.
 */
export default async function ConsultantsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; edit?: string; saved?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { error, edit, saved } = await searchParams;

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

  const editing = edit
    ? (consultants.find((consultant) => consultant.id === edit) ?? null)
    : null;

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
        address: String(formData.get("address") || "").trim() || null,
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

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const vendorId = String(formData.get("vendorId") || "");
    try {
      await updateVendor({
        companyId: inner.companyId,
        userId: inner.userId,
        vendorId,
        kind: "CONSULTANT",
        formData,
      });
    } catch (thrown) {
      if (thrown instanceof PartyError) {
        redirect(`/consultants?edit=${vendorId}&error=${thrown.problem}`);
      }
      throw thrown;
    }
    redirect("/consultants?saved=1");
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
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "rate" ? (
        <Alert tone="error">A default rate is a number, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? (
        <Alert tone="error">That consultant is no longer here.</Alert>
      ) : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {consultants.length === 0 ? (
            <EmptyState title="No consultants yet">
              Add the first one on the right. A default rate and the email addresses to send work
              orders to are what make the rest of the app quick.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Work orders go to</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Owed</th>
                  <th />
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
                      <td className="py-2 text-right">
                        <Link
                          href={`/consultants?edit=${consultant.id}`}
                          className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">
            {editing ? `Edit ${editing.name}` : "Add a consultant"}
          </h2>
          {editing ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Currency, rate, terms and account are the defaults for the next
              work order. Work orders already raised keep theirs.
            </p>
          ) : null}
          <form
            key={editing?.id ?? "new"}
            action={editing ? save : create}
            className="space-y-4"
          >
            {editing ? <input type="hidden" name="vendorId" value={editing.id} /> : null}
            <Field label="Name">
              <Input name="name" required defaultValue={editing?.name ?? ""} />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" defaultValue={editing?.email ?? ""} />
            </Field>
            <Field label="Cc" hint="Comma separated — a manager or agency contact.">
              <Input name="ccEmails" defaultValue={editing?.ccEmails.join(", ") ?? ""} />
            </Field>
            <Field label="Address">
              <Input name="address" defaultValue={editing?.address ?? ""} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="sendEmails"
                defaultChecked={editing ? editing.sendEmails : true}
              />
              Include in work order emails
            </label>
            <Field label="Currency">
              <Select name="defaultCurrency" defaultValue={editing?.defaultCurrency ?? "PHP"}>
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Default rate">
              <Input
                name="defaultRate"
                inputMode="decimal"
                defaultValue={editing?.defaultRate ? editing.defaultRate.toFixed(2) : ""}
              />
            </Field>
            <Field label="Default expense account">
              <Select name="defaultAccountId" defaultValue={editing?.defaultAccountId ?? ""}>
                <option value="">None</option>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payment terms (days)">
              <Input
                name="paymentTermsDays"
                type="number"
                defaultValue={editing?.paymentTermsDays ?? 15}
                min={0}
              />
            </Field>
            <Field label="Notes">
              <Input name="notes" defaultValue={editing?.notes ?? ""} />
            </Field>
            <Field
              label="Spreadsheet code"
              hint="Optional. Helps the import match this person when a sheet names them differently."
            >
              <Input name="externalRef" defaultValue={editing?.externalRef ?? ""} />
            </Field>
            {editing ? (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="isActive"
                  defaultChecked={editing.isActive}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
                />
                Active
              </label>
            ) : null}
            <div className="flex items-center gap-2">
              <Button type="submit">{editing ? "Save changes" : "Add consultant"}</Button>
              {editing ? (
                <Link
                  href="/consultants"
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
