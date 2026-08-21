import { redirect } from "next/navigation";
import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui";
import { COMMON_TIME_ZONES, MONTHS } from "@/lib/currency";

export default async function CompanySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
  });
  const { saved } = await searchParams;

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");

    const name = String(formData.get("name") || "").trim();
    const fiscalYearStartMonth = Number(formData.get("fiscalYearStartMonth"));
    const timeClockTimeZone = String(formData.get("timeClockTimeZone"));
    const operatingTimeZone = String(formData.get("operatingTimeZone"));

    if (!name) redirect("/settings/company");
    if (
      !Number.isInteger(fiscalYearStartMonth) ||
      fiscalYearStartMonth < 1 ||
      fiscalYearStartMonth > 12
    ) {
      redirect("/settings/company");
    }

    await prisma.company.update({
      // Scoped by id AND companyId so this can never touch another company.
      where: { id: inner.companyId },
      data: {
        name,
        fiscalYearStartMonth,
        timeClockTimeZone,
        operatingTimeZone,
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "company.updated",
      entityType: "Company",
      entityId: inner.companyId,
      data: {
        name,
        fiscalYearStartMonth,
        timeClockTimeZone,
        operatingTimeZone,
      },
    });
    redirect("/settings/company?saved=1");
  }

  return (
    <>
      <PageHeader
        title="Company settings"
        description="Base currency cannot be changed."
      />
      <Card className="max-w-xl">
        {saved ? <Alert tone="success">Saved.</Alert> : null}
        <form action={save} className="mt-2 space-y-4">
          <Field label="Company name">
            <Input name="name" defaultValue={company.name} required />
          </Field>
          <Field
            label="Base currency"
            hint="Fixed at setup. Changing it after postings exist is not supported (SPEC §5)."
          >
            <Input value={company.baseCurrency} disabled readOnly />
          </Field>
          <Field label="Fiscal year starts">
            <Select
              name="fiscalYearStartMonth"
              defaultValue={company.fiscalYearStartMonth}
            >
              {MONTHS.map((month, index) => (
                <option key={month} value={index + 1}>
                  {month}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Time clock time zone"
            hint="Clock in/out display, day grouping and timesheet totals (SPEC §9)."
          >
            <Select
              name="timeClockTimeZone"
              defaultValue={company.timeClockTimeZone}
            >
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Operating time zone"
            hint="Scheduled jobs such as recurring invoicing. Deliberately separate from the clock zone."
          >
            <Select
              name="operatingTimeZone"
              defaultValue={company.operatingTimeZone}
            >
              {COMMON_TIME_ZONES.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit">Save changes</Button>
        </form>
      </Card>

      {/* SPEC §13: the books must never feel trapped in this app. Owner only —
          the archive crosses every section boundary at once. */}
      {scope.hasRole("OWNER") ? (
        <Card className="mt-6">
          <h2 className="text-sm font-semibold">Your data</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            A zip of CSVs covering everything this company holds — the chart of
            accounts, every journal line, customers, vendors, invoices, work
            orders, payments, time entries and the audit log. Readable in any
            spreadsheet, and enough for another accountant to rebuild these
            books.
          </p>
          <p className="mt-2 text-sm text-slate-500">
            For a restorable database backup rather than a readable copy, use
            the <code>pg_dump</code> command in the project README.
          </p>
          {/* A route handler, so the browser saves the file rather than
              navigating to it; `download` keeps Next from client-routing. */}
          <a
            href="/settings/export"
            download
            className="mt-4 inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Download a full data export
          </a>
        </Card>
      ) : null}
    </>
  );
}
