import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { failTo } from "@/lib/fail";
import { PostingError } from "@/lib/errors";
import { createCompany } from "@/lib/companies";
import { setActiveCompany } from "@/lib/active-company";
import { COMMON_TIME_ZONES, MONTHS, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("New company") };

/**
 * Create a second (or fifth) set of books (SPEC §3).
 *
 * Switching between companies already existed; this is the missing half. A new
 * company shares nothing with its siblings but the login: its own chart of
 * accounts, customers, vendors, A/R, A/P and its own user list.
 *
 * Owner-only. The creator becomes the new company's OWNER, which is a grant of
 * access, and someone who cannot manage users in the company they are standing
 * in should not be able to mint one where they can.
 */
export default async function NewCompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await companyScope();
  const { error } = await searchParams;

  if (!scope.hasRole("OWNER")) {
    return (
      <>
        <PageHeader title="New company" />
        <Alert tone="warning">
          Only an owner can create a company. Your role in this company is{" "}
          {scope.role.toLowerCase()}.
        </Alert>
      </>
    );
  }

  const current = await prisma.company.findUniqueOrThrow({
    where: { id: scope.companyId },
    select: { timeClockTimeZone: true, operatingTimeZone: true, fiscalYearStartMonth: true },
  });

  async function create(formData: FormData) {
    "use server";
    const inner = await companyScope();
    inner.requireRole("OWNER");
    const back = "/companies/new";

    try {
      const company = await createCompany({
        name: String(formData.get("name") || ""),
        baseCurrency: String(formData.get("baseCurrency") || ""),
        fiscalYearStartMonth: Number(formData.get("fiscalYearStartMonth")),
        timeClockTimeZone: String(formData.get("timeClockTimeZone")),
        operatingTimeZone: String(formData.get("operatingTimeZone")),
        userId: inner.userId,
      });
      // Straight into the new books: creating one and then having to find it in
      // the switcher is a step that exists for no reason.
      await setActiveCompany(company.id);
    } catch (caught) {
      if (caught instanceof PostingError) failTo(back, caught.message);
      throw caught;
    }
    redirect("/dashboard");
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="New company"
          description="A separate set of books. Nothing is shared with your other companies but the login."
        />
        <Link href="/dashboard">
          <Button variant="secondary">Cancel</Button>
        </Link>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card className="max-w-xl">
        <form action={create} className="space-y-4">
          <Field
            label="Company name"
            hint="What it is called in the switcher at the top of every screen."
          >
            <Input name="name" required autoFocus />
          </Field>

          <Field
            label="Base currency"
            hint="Permanent. Every report is in this currency, and it cannot be changed once anything is posted."
          >
            <Select name="baseCurrency" defaultValue="PHP">
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} — {currency.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Fiscal year starts in">
            <Select
              name="fiscalYearStartMonth"
              defaultValue={String(current.fiscalYearStartMonth)}
            >
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Operating time zone" hint="When scheduled jobs run.">
              <Select name="operatingTimeZone" defaultValue={current.operatingTimeZone}>
                {COMMON_TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Time clock time zone" hint="How consultants' hours are shown.">
              <Select name="timeClockTimeZone" defaultValue={current.timeClockTimeZone}>
                {COMMON_TIME_ZONES.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Alert tone="info">
            It starts with a standard chart of accounts and its own document numbering. You will
            be its owner; add its users under Settings → Users once you are in.
          </Alert>

          <div className="flex justify-end">
            <Button type="submit">Create company</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
