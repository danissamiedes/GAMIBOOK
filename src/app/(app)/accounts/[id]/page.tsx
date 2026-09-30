import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { AccountSubtype, AccountType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { SUBTYPES_BY_TYPE, TYPE_ORDER, normalBalance } from "@/lib/ledger/accounts";
import {
  ACCOUNT_EDIT_MESSAGES,
  updateAccount,
  type AccountEditProblem,
} from "@/lib/ledger/edit-account";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit account") };

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

/**
 * One account you added yourself (SPEC §4.1).
 *
 * Reached by clicking the code in the chart. System accounts have no link
 * here and this page refuses them: the app posts to them by key, and their
 * names are what every other screen says.
 */
export default async function EditAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const { id } = await params;
  const { error } = await searchParams;

  const account = await prisma.account.findFirst({
    where: { id, ...scope.where },
    include: { _count: { select: { lines: true } } },
  });
  if (!account) notFound();

  const postings = account._count.lines;
  const typeLocked = postings > 0;

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const result = await updateAccount(inner, id, {
      code: String(formData.get("code") || ""),
      name: String(formData.get("name") || ""),
      description: String(formData.get("description") || ""),
      type: String(formData.get("type") || "") as AccountType,
      subtype: String(formData.get("subtype") || "") as AccountSubtype,
    });

    if (!result.ok) redirect(`/accounts/${id}?error=${result.problem}`);
    redirect(`/accounts?saved=${encodeURIComponent(`${result.code} ${result.name}`)}${
      result.restatesReports ? "&restated=1" : ""
    }`);
  }

  return (
    <>
      <PageHeader
        title={`${account.code} ${account.name}`}
        description={
          postings === 0
            ? "Nothing has been posted to this account yet."
            : `${postings} posting${postings === 1 ? "" : "s"} refer to this account.`
        }
      />

      <div className="mb-4">
        <Link href="/accounts">
          <Button variant="ghost">Chart of accounts</Button>
        </Link>
      </div>

      {account.isSystem ? (
        <Card className="max-w-xl">
          <Alert tone="warning">{ACCOUNT_EDIT_MESSAGES.system}</Alert>
        </Card>
      ) : (
        <Card className="max-w-xl">
          {error ? (
            <Alert tone="error">
              {ACCOUNT_EDIT_MESSAGES[error as AccountEditProblem] ?? "That could not be saved."}
            </Alert>
          ) : null}

          <form action={save} className="mt-2 space-y-4">
            <Field label="Code" hint="Sorts the reports. Changing it moves nothing in the ledger.">
              <Input name="code" defaultValue={account.code} required />
            </Field>

            <Field label="Name">
              <Input name="name" defaultValue={account.name} required />
            </Field>

            <Field label="Description" hint="Optional. A note about what belongs in here.">
              <Input name="description" defaultValue={account.description ?? ""} />
            </Field>

            <Field
              label="Type"
              hint={
                typeLocked
                  ? "Locked: this account has postings, and changing its type would rewrite every report it appears in."
                  : "Still changeable — nothing has been posted to it yet."
              }
            >
              <Select name="type" defaultValue={account.type} disabled={typeLocked}>
                {TYPE_ORDER.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABELS[type]} ({normalBalance(type).toLowerCase()}-normal)
                  </option>
                ))}
              </Select>
              {/* A disabled select submits nothing, so the current value has to
                  travel some other way or the save would read it as empty. */}
              {typeLocked ? <input type="hidden" name="type" value={account.type} /> : null}
            </Field>

            <Field
              label="Subtype"
              hint="Decides which section of the reports this account appears in — this is where an expense becomes Cost of Sales."
            >
              <Select name="subtype" defaultValue={account.subtype}>
                {(typeLocked ? [account.type] : TYPE_ORDER).flatMap((type) =>
                  SUBTYPES_BY_TYPE[type].map((subtype) => (
                    <option key={`${type}-${subtype}`} value={subtype}>
                      {TYPE_LABELS[type]} — {humanSubtype(subtype)}
                    </option>
                  )),
                )}
              </Select>
            </Field>

            {postings > 0 ? (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                Moving this account to a different section restates every period it has postings
                in. The figures themselves do not change — where they are reported does.
              </p>
            ) : null}

            <Button type="submit">Save changes</Button>
          </form>
        </Card>
      )}
    </>
  );
}
