import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Items — Ledger" };

/** SPEC §6: light. Pre-fills document lines; deliberately not inventory. */
export default async function ItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;

  const [items, accounts] = await Promise.all([
    prisma.item.findMany({ where: scope.where, orderBy: { name: "asc" } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: { in: ["INCOME", "EXPENSE"] } },
      orderBy: { code: "asc" },
    }),
  ]);

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const name = String(formData.get("name") || "").trim();
    if (!name) redirect("/items?error=name");

    const incomeAccountId = String(formData.get("incomeAccountId") || "") || null;
    const expenseAccountId = String(formData.get("expenseAccountId") || "") || null;
    const rate = String(formData.get("defaultRate") || "").trim();

    const existing = await prisma.item.findFirst({ where: { ...inner.where, name } });
    if (existing) redirect("/items?error=duplicate");

    await prisma.item.create({
      data: {
        companyId: inner.companyId,
        name,
        description: String(formData.get("description") || "").trim() || null,
        defaultRate: rate ? rate : null,
        incomeAccountId,
        expenseAccountId,
      },
    });
    redirect("/items");
  }

  return (
    <>
      <PageHeader
        title="Items and services"
        description="Used to pre-fill invoice and work order lines."
      />
      {error === "duplicate" ? <Alert tone="error">That name is already used.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {items.length === 0 ? (
            <EmptyState title="No items yet">Optional — lines can always be typed by hand.</EmptyState>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2">Name</th>
                  <th className="py-2">Description</th>
                  <th className="py-2 text-right">Default rate</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">{item.name}</td>
                    <td className="py-2 text-slate-500">{item.description ?? "—"}</td>
                    <td className="py-2 text-right tabular-nums">
                      {item.defaultRate ? item.defaultRate.toFixed(2) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Add an item</h2>
          <form action={create} className="space-y-4">
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Description">
              <Input name="description" />
            </Field>
            <Field label="Default rate">
              <Input name="defaultRate" inputMode="decimal" />
            </Field>
            <Field label="Income account (invoices)">
              <Select name="incomeAccountId" defaultValue="">
                <option value="">None</option>
                {accounts
                  .filter((account) => account.type === "INCOME")
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Expense account (work orders)">
              <Select name="expenseAccountId" defaultValue="">
                <option value="">None</option>
                {accounts
                  .filter((account) => account.type === "EXPENSE")
                  .map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Button type="submit">Add item</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
