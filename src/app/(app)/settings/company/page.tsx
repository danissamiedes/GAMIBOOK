import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
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
import { COMPANY_THEMES, isCompanyTheme } from "@/lib/company-theme";

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
    const requestedTheme = String(formData.get("theme") || "");
    // An unknown value leaves the accent alone rather than throwing: it can
    // only come from a hand-edited form, and losing a colour is not worth a
    // stack trace.
    const theme = isCompanyTheme(requestedTheme) ? requestedTheme : undefined;

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
        ...(theme ? { theme } : {}),
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
        theme: theme ?? null,
      },
    });
    // The accent lives on the app shell, and a layout is not re-rendered by a
    // redirect within its own segment — so without this, changing the colour
    // saves and appears to do nothing until a hard reload.
    revalidatePath("/", "layout");
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
          <Field
            label="Accent colour"
            hint="Shown across this company's screens, so a glance says whose books are open. Only the accent moves — red still means overdue and green still means money in."
          >
            <Select name="theme" defaultValue={company.theme}>
              {COMPANY_THEMES.map((theme) => (
                <option key={theme.value} value={theme.value}>
                  {theme.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2" aria-hidden="true">
            {COMPANY_THEMES.map((theme) => (
              <span
                key={theme.value}
                title={theme.label}
                className={`h-6 w-10 rounded border ${
                  company.theme === theme.value
                    ? "border-slate-900 dark:border-slate-100"
                    : "border-slate-200 dark:border-slate-700"
                }`}
                style={{ background: theme.swatch }}
              />
            ))}
          </div>
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
            className="mt-4 inline-flex items-center rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 dark:hover:bg-brand-500"
          >
            Download a full data export
          </a>
        </Card>
      ) : null}
    </>
  );
}
