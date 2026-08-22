import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { SUPPORTED_CURRENCIES, formatMoney, isSupportedCurrency } from "@/lib/currency";
import { money, sum } from "@/lib/money";
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
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { error } = await searchParams;

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

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Suppliers you receive bills from. Consultants are set up separately."
      />
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}

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
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Add a vendor</h2>
          <form action={create} className="space-y-4">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Email">
              <Input name="email" type="email" />
            </Field>
            <Field label="Currency">
              <Select name="defaultCurrency" defaultValue={company.baseCurrency}>
                {SUPPORTED_CURRENCIES.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.label}
                  </option>
                ))}
              </Select>
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
              <Input name="paymentTermsDays" type="number" defaultValue={30} min={0} />
            </Field>
            <Field label="Notes">
              <Input name="notes" />
            </Field>
            <Button type="submit">Add vendor</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
