import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import { storage, storageKeys } from "@/lib/storage";
import { maxImportBytes, maxImportLabel, ImportParseError } from "@/lib/imports/parse";
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

export const metadata = { title: pageTitle("Banking") };

/**
 * Bank accounts and statement uploads (SPEC §8.4). Reconciling is the daily
 * bookkeeping job, so this screen is the way in: what is unmatched, per
 * account, and a place to drop the next statement.
 */
export default async function BankingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const scope = await sectionScope("BANKING");
  const params = await searchParams;

  const [company, accounts, cashAccounts, batches] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.bankAccount.findMany({
      where: scope.where,
      include: {
        account: { select: { code: true, name: true } },
        _count: {
          select: { transactions: { where: { status: "UNMATCHED" } } },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: {
        ...scope.where,
        isActive: true,
        subtype: { in: ["CASH", "UNDEPOSITED_FUNDS", "CREDIT_CARD"] },
      },
      orderBy: { code: "asc" },
    }),
    prisma.importBatch.findMany({
      where: { ...scope.where, kind: "BANK" },
      orderBy: { uploadedAt: "desc" },
      take: 8,
    }),
  ]);

  async function createAccount(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const name = String(formData.get("name") || "").trim();
    if (!name) failTo("/banking", "Give the account a name");
    const accountId = String(formData.get("accountId") || "");
    const account = await prisma.account.findFirst({
      where: { id: accountId, companyId: inner.companyId },
    });
    if (!account)
      failTo("/banking", "Pick the ledger account this money sits in");

    const existing = await prisma.bankAccount.findFirst({
      where: { companyId: inner.companyId, name },
    });
    if (existing)
      failTo("/banking", `There is already an account called "${name}"`);

    const created = await prisma.bankAccount.create({
      data: {
        companyId: inner.companyId,
        name,
        accountId: account!.id,
        currency: String(formData.get("currency") || "").toUpperCase() || "PHP",
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "bankAccount.created",
      entityType: "BankAccount",
      entityId: created.id,
      summary: name,
    });
    redirect("/banking?saved=1");
  }

  async function upload(formData: FormData) {
    "use server";
    const inner = await sectionScope("BANKING");
    const bankAccountId = String(formData.get("bankAccountId") || "");
    const bankAccount = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, companyId: inner.companyId },
    });
    if (!bankAccount) failTo("/banking", "Pick a bank account");

    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0)
      failTo("/banking", "Choose a statement file");
    const upload = file as File;
    if (upload.size > maxImportBytes())
      failTo("/banking", `That file is over ${maxImportLabel()}`);

    // Staged as a batch with the file kept, so the mapping screen can re-read
    // it as the user changes columns without making them upload again.
    const batch = await prisma.importBatch.create({
      data: {
        companyId: inner.companyId,
        kind: "BANK",
        status: "PARSED",
        fileName: upload.name,
        fileHash: "",
        uploadedByUserId: inner.userId,
      },
    });

    try {
      const bytes = Buffer.from(await upload.arrayBuffer());
      const fileKey = storageKeys.importFile(
        inner.companyId,
        batch.id,
        upload.name,
      );
      await storage().put(fileKey, bytes);
      await prisma.importBatch.update({
        where: { id: batch.id },
        data: { fileKey, sheetName: bankAccountId },
      });
    } catch (error) {
      await prisma.importBatch.delete({ where: { id: batch.id } });
      if (error instanceof ImportParseError) failTo("/banking", error.message);
      throw error;
    }

    redirect(`/banking/import/${batch.id}`);
  }

  const totalUnmatched = accounts.reduce(
    (total, account) => total + account._count.transactions,
    0,
  );

  return (
    <>
      <PageHeader
        title="Banking"
        description={`${company.name} · ${totalUnmatched} transaction${
          totalUnmatched === 1 ? "" : "s"
        } waiting to be matched`}
      />

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Bank accounts</h2>
            {accounts.length === 0 ? (
              <EmptyState title="No bank accounts yet">
                Add one for each real account you hold, pointing at the ledger
                account its money sits in. Statements are imported per account.
              </EmptyState>
            ) : (
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2">Account</th>
                    <th className="py-2">Posts to</th>
                    <th className="py-2">Mapping</th>
                    <th className="py-2 text-right">Unmatched</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr
                      key={account.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">
                        {account.name}
                        <span className="ml-2 text-xs text-slate-500">
                          {account.currency}
                        </span>
                      </td>
                      <td className="py-2 text-xs">
                        {account.account.code} — {account.account.name}
                      </td>
                      <td className="py-2 text-xs text-slate-500">
                        {account.dateColumn ? "saved" : "not set up yet"}
                      </td>
                      <td className="py-2 text-right">
                        {account._count.transactions > 0 ? (
                          <Link
                            className="underline"
                            href={`/banking/match?account=${account.id}`}
                          >
                            {account._count.transactions}
                          </Link>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          {batches.length > 0 ? (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Recent statements</h2>
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2">File</th>
                    <th className="py-2">Uploaded</th>
                    <th className="py-2">Status</th>
                    <th className="py-2 text-right">Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => (
                    <tr
                      key={batch.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">
                        {batch.status === "PARSED" ? (
                          <Link
                            className="underline"
                            href={`/banking/import/${batch.id}`}
                          >
                            {batch.fileName}
                          </Link>
                        ) : (
                          batch.fileName
                        )}
                      </td>
                      <td className="py-2 text-xs">
                        {batch.uploadedAt
                          .toISOString()
                          .slice(0, 16)
                          .replace("T", " ")}
                      </td>
                      <td className="py-2 text-xs">
                        {batch.status.toLowerCase()}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {batch.createdCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-6">
          <Card tone="muted">
            <h2 className="mb-3 text-sm font-semibold">Import a statement</h2>
            {accounts.length === 0 ? (
              <p className="text-sm text-slate-500">
                Add a bank account first.
              </p>
            ) : (
              <form action={upload} className="space-y-3">
                <Field label="Into">
                  <Select name="bankAccountId" required>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="File" hint={`.csv or .xlsx, up to ${maxImportLabel()}.`}>
                  <Input type="file" name="file" accept=".csv,.xlsx" required />
                </Field>
                <Button type="submit">Upload</Button>
                <p className="text-xs text-slate-500">
                  Nothing is imported until you have checked the columns on the
                  next screen.
                </p>
              </form>
            )}
          </Card>

          <Card tone="muted">
            <h2 className="mb-3 text-sm font-semibold">Add a bank account</h2>
            <form action={createAccount} className="space-y-3">
              <Field
                label="Name"
                hint="What you call it — “BPI current account”."
              >
                <Input name="name" required />
              </Field>
              <Field
                label="Posts to"
                hint="The ledger account this money sits in. Its balance is what a statement reconciles against."
              >
                <Select name="accountId" required>
                  {cashAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Currency">
                <Input
                  name="currency"
                  defaultValue={company.baseCurrency}
                  maxLength={3}
                />
              </Field>
              <Button type="submit">Add account</Button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
