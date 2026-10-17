import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { failTo } from "@/lib/fail";
import { writeAudit } from "@/lib/audit";
import { PostingError } from "@/lib/errors";
import { parseMoney } from "@/lib/money";
import { isoDate, parseAccountingDate, today } from "@/lib/dates";
import { recordVendorCredit } from "@/lib/payables/vendor-credits";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { PARTIES, readParty } from "../party";

export const metadata = { title: pageTitle("Record a credit note") };

/**
 * Recording a credit note (SPEC §8.5). This is the step that posts: accounts
 * payable goes down and the cost comes back out of whichever account it went
 * to. Which bill it answers is decided afterwards, on the credit's own page,
 * because the two are genuinely separate decisions and often days apart.
 */
export default async function NewVendorCreditPage({
  searchParams,
}: {
  searchParams: Promise<{ party?: string; error?: string; vendor?: string }>;
}) {
  const params = await searchParams;
  const party = readParty(params.party);
  const config = PARTIES[party];
  const scope = await sectionScope(config.section);

  const [company, parties, expenseAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: config.kind, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, defaultCurrency: true },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const currencies = [
    ...new Set([company.baseCurrency, ...parties.map((row) => row.defaultCurrency)]),
  ];
  const back = `/vendor-credits?party=${party}`;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope(config.section);
    const amount = parseMoney(String(formData.get("amount") || ""));
    const here = `/vendor-credits/new?party=${party}`;
    if (!amount) failTo(here, "Enter the amount of the credit");

    let creditId: string;
    try {
      const { credit } = await recordVendorCredit({
        companyId: inner.companyId,
        vendorId: String(formData.get("vendorId") || ""),
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        reference: String(formData.get("reference") || ""),
        currency: String(formData.get("currency") || ""),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        amount: amount!,
        expenseAccountId: String(formData.get("expenseAccountId") || ""),
        memo: String(formData.get("memo") || ""),
        userId: inner.userId,
        role: inner.role,
      });
      creditId = credit.id;
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "vendor_credit.recorded",
        entityType: "VendorCredit",
        entityId: credit.id,
        summary: `${credit.reference} · ${credit.currency} ${credit.amount.toFixed(2)}`,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(here, thrown.message);
      throw thrown;
    }
    redirect(`/vendor-credits/${creditId}?saved=1`);
  }

  return (
    <>
      <PageHeader
        title={`Record a ${config.noun.toLowerCase()} credit note`}
        description="A returned delivery, a line billed twice, a discount agreed after the invoice."
      />
      <div className="mb-4">
        <Link href={back}>
          <Button variant="ghost">All credit notes</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      {parties.length === 0 ? (
        <Alert tone="warning">
          There is no active {config.noun.toLowerCase()} to credit yet.
        </Alert>
      ) : (
        <Card>
          <form action={create} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={config.noun}>
                <Select name="vendorId" defaultValue={params.vendor ?? parties[0]?.id} required>
                  {parties.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date">
                <Input type="date" name="date" defaultValue={isoDate(today())} required />
              </Field>
              <Field
                label="Reference"
                hint="The credit note's own number. Required, as on a bill."
              >
                <Input name="reference" required />
              </Field>
              <Field label="Amount">
                <Input name="amount" inputMode="decimal" required />
              </Field>
              <Field label="Currency">
                <Select name="currency" defaultValue={company.baseCurrency}>
                  {currencies.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
                <Input name="fxRate" inputMode="decimal" defaultValue="1" />
              </Field>
              <div className="sm:col-span-2">
                <Field
                  label="Account the credit reverses"
                  hint="Normally the account the original bill was coded to."
                >
                  <Select name="expenseAccountId" defaultValue={expenseAccounts[0]?.id} required>
                    {expenseAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Memo" hint="Optional. What the credit is for.">
                  <Input name="memo" />
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button type="submit">Record credit note</Button>
              <Link
                href={back}
                className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </Link>
            </div>
            <p className="text-xs text-slate-500">
              Recording posts immediately: accounts payable down, the cost back out. Setting it
              against a bill comes next, on the credit note&apos;s own page, and posts nothing.
            </p>
          </form>
        </Card>
      )}
    </>
  );
}
