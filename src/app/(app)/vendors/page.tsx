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

export const metadata = { title: pageTitle("Vendors") };

/** Regular vendors only (SPEC §6). Consultants live in their own section. */
export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; edit?: string; saved?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { error, edit, saved } = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [vendors, expenseAccounts] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR" },
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      include: {
        expenses: {
          where: { kind: "BILL", status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
          select: { balanceDue: true, fxRate: true },
        },
      },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
    }),
  ]);

  const editing = edit ? (vendors.find((vendor) => vendor.id === edit) ?? null) : null;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const name = String(formData.get("name") || "").trim();
    const currency = String(formData.get("defaultCurrency") || "").toUpperCase();
    if (!name) redirect("/vendors?error=name");
    if (!isSupportedCurrency(currency)) redirect("/vendors?error=currency");

    const vendor = await prisma.vendor.create({
      data: {
        companyId: inner.companyId,
        kind: "REGULAR",
        name,
        email: String(formData.get("email") || "").trim() || null,
        address: String(formData.get("address") || "").trim() || null,
        defaultCurrency: currency,
        defaultAccountId: String(formData.get("defaultAccountId") || "") || null,
        paymentTermsDays: Number(formData.get("paymentTermsDays") || 30),
        notes: String(formData.get("notes") || "").trim() || null,
        sendEmails: false,
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "vendor.created",
      entityType: "Vendor",
      entityId: vendor.id,
      summary: name,
    });
    redirect("/vendors");
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const vendorId = String(formData.get("vendorId") || "");
    try {
      await updateVendor({
        companyId: inner.companyId,
        userId: inner.userId,
        vendorId,
        kind: "REGULAR",
        formData,
      });
    } catch (thrown) {
      if (thrown instanceof PartyError) {
        redirect(`/vendors?edit=${vendorId}&error=${thrown.problem}`);
      }
      throw thrown;
    }
    redirect("/vendors?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Suppliers you receive bills from. Consultants are set up separately."
      />
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
      {error === "notFound" ? <Alert tone="error">That vendor is no longer here.</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {vendors.length === 0 ? (
            <EmptyState title="No vendors yet">
              Add the first one on the right. Vendors here are the regular kind — consultants live
              on their own screen because their documents work differently.
            </EmptyState>
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Email</th>
                  <th className="py-2">Currency</th>
                  <th className="py-2">Terms</th>
                  <th className="py-2 text-right">Owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {vendors.map((vendor) => {
                  const owed = sum(
                    vendor.expenses.map((bill) => money(bill.balanceDue).times(money(bill.fxRate))),
                  );
                  return (
                    <tr key={vendor.id} className="border-b border-slate-100 dark:border-slate-800/60">
                      <td className="py-2">
                        <span className={vendor.isActive ? "" : "text-slate-400 line-through"}>
                          {vendor.name}
                        </span>
                      </td>
                      <td className="py-2 text-slate-500">{vendor.email ?? "—"}</td>
                      <td className="py-2">{vendor.defaultCurrency}</td>
                      <td className="py-2 text-slate-500">Net {vendor.paymentTermsDays}</td>
                      <td className="py-2 text-right tabular-nums">
                        {owed.isZero() ? "—" : formatMoney(owed.toFixed(2), company.baseCurrency)}
                      </td>
                      <td className="py-2 text-right">
                        <Link
                          href={`/vendors?edit=${vendor.id}`}
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
            {editing ? `Edit ${editing.name}` : "Add a vendor"}
          </h2>
          {editing ? (
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Currency, terms and account are the defaults for the next bill.
              Bills already recorded keep the ones they were entered with.
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
            <Field label="Address">
              <Input name="address" defaultValue={editing?.address ?? ""} />
            </Field>
            <Field label="Currency">
              <Select
                name="defaultCurrency"
                defaultValue={editing?.defaultCurrency ?? company.baseCurrency}
              >
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
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
                defaultValue={editing?.paymentTermsDays ?? 30}
                min={0}
              />
            </Field>
            <Field label="Notes">
              <Input name="notes" defaultValue={editing?.notes ?? ""} />
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
              <Button type="submit">{editing ? "Save changes" : "Add vendor"}</Button>
              {editing ? (
                <Link
                  href="/vendors"
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
