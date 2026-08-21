import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { createDefaultChartOfAccounts, deactivateAccount } from "@/lib/ledger/chart";
import { SUBTYPES_BY_TYPE, TYPE_ORDER, normalBalance } from "@/lib/ledger/accounts";
import type { AccountSubtype, AccountType } from "@prisma/client";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Chart of accounts — Ledger" };

const TYPE_LABELS: Record<AccountType, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  INCOME: "Income",
  EXPENSE: "Expenses",
};

function humanSubtype(subtype: AccountSubtype): string {
  return subtype
    .toLowerCase()
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const { error, created } = await searchParams;

  const accounts = await prisma.account.findMany({
    where: scope.where,
    orderBy: { code: "asc" },
    include: { _count: { select: { lines: true } } },
  });

  async function installDefaults() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const result = await createDefaultChartOfAccounts(inner.companyId);
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "chart_of_accounts.installed",
      entityType: "Account",
      summary: `${result.created} accounts created`,
    });
    redirect(`/accounts?created=${result.created}`);
  }

  async function addAccount(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const code = String(formData.get("code") || "").trim();
    const name = String(formData.get("name") || "").trim();
    const type = String(formData.get("type") || "") as AccountType;
    const subtype = String(formData.get("subtype") || "") as AccountSubtype;

    if (!code || !name) redirect("/accounts?error=required");
    if (!SUBTYPES_BY_TYPE[type]?.includes(subtype)) redirect("/accounts?error=subtype");

    const clash = await prisma.account.findFirst({ where: { ...inner.where, code } });
    if (clash) redirect("/accounts?error=duplicate");

    const account = await prisma.account.create({
      data: { companyId: inner.companyId, code, name, type, subtype },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "account.created",
      entityType: "Account",
      entityId: account.id,
      summary: `${code} ${name}`,
    });
    redirect("/accounts");
  }

  async function toggleActive(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const accountId = String(formData.get("accountId") || "");
    const account = await prisma.account.findFirst({
      where: { id: accountId, ...inner.where },
    });
    if (!account) redirect("/accounts");

    if (account.isActive) {
      try {
        await deactivateAccount(inner.companyId, accountId);
      } catch {
        redirect("/accounts?error=system");
      }
    } else {
      await prisma.account.update({ where: { id: account.id }, data: { isActive: true } });
    }
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: account.isActive ? "account.deactivated" : "account.reactivated",
      entityType: "Account",
      entityId: account.id,
      summary: `${account.code} ${account.name}`,
    });
    redirect("/accounts");
  }

  if (accounts.length === 0) {
    return (
      <>
        <PageHeader title="Chart of accounts" />
        <EmptyState title="This company has no accounts yet">
          <form action={installDefaults} className="mt-4">
            <Button type="submit">Install the default chart of accounts</Button>
          </form>
          <p className="mt-3 text-xs">
            Around 30 accounts covering cash, receivables, payables, equity, consulting income and
            the usual costs — including every account the app posts to automatically.
          </p>
        </EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="System accounts are the ones the app posts to automatically. They cannot be removed or retyped."
      />

      {created ? <Alert tone="success">{created} accounts created.</Alert> : null}
      {error === "duplicate" ? <Alert tone="error">That code is already in use.</Alert> : null}
      {error === "required" ? <Alert tone="error">Code and name are both required.</Alert> : null}
      {error === "subtype" ? <Alert tone="error">Pick a subtype that matches the type.</Alert> : null}
      {error === "system" ? <Alert tone="error">System accounts cannot be deactivated.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          {TYPE_ORDER.map((type) => {
            const rows = accounts.filter((account) => account.type === type);
            if (rows.length === 0) return null;
            return (
              <section key={type} className="mb-6 last:mb-0">
                <h2 className="mb-2 text-sm font-semibold">
                  {TYPE_LABELS[type]}{" "}
                  <span className="font-normal text-slate-500">
                    ({normalBalance(type).toLowerCase()}-normal)
                  </span>
                </h2>
                <table className="w-full text-sm">
                  <tbody>
                    {rows.map((account) => (
                      <tr
                        key={account.id}
                        className="border-b border-slate-100 last:border-0 dark:border-slate-800/60"
                      >
                        <td className="w-16 py-1.5 font-mono text-xs text-slate-500">
                          {account.code}
                        </td>
                        <td className="py-1.5">
                          <span className={account.isActive ? "" : "text-slate-400 line-through"}>
                            {account.name}
                          </span>
                          {account.isSystem ? (
                            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              system
                            </span>
                          ) : null}
                        </td>
                        <td className="py-1.5 text-xs text-slate-500">
                          {humanSubtype(account.subtype)}
                        </td>
                        <td className="py-1.5 text-right text-xs text-slate-500">
                          {account._count.lines > 0 ? `${account._count.lines} postings` : "—"}
                        </td>
                        <td className="py-1.5 text-right">
                          {account.isSystem ? null : (
                            <form action={toggleActive}>
                              <input type="hidden" name="accountId" value={account.id} />
                              <Button variant="ghost" type="submit">
                                {account.isActive ? "Deactivate" : "Reactivate"}
                              </Button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Add an account</h2>
          <form action={addAccount} className="space-y-4">
            <Field label="Code" hint="Sorts the reports. Keep the numbering scheme consistent.">
              <Input name="code" required />
            </Field>
            <Field label="Name">
              <Input name="name" required />
            </Field>
            <Field label="Type">
              <Select name="type" defaultValue="EXPENSE">
                {TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Subtype" hint="Decides where the account appears in reports.">
              <Select name="subtype" defaultValue="EXPENSE">
                {TYPE_ORDER.flatMap((type) =>
                  SUBTYPES_BY_TYPE[type].map((subtype) => (
                    <option key={`${type}-${subtype}`} value={subtype}>
                      {TYPE_LABELS[type]} — {humanSubtype(subtype)}
                    </option>
                  )),
                )}
              </Select>
            </Field>
            <Button type="submit">Add account</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
