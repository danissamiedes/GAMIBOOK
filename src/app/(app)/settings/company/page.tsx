import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { connectedMailbox } from "@/lib/email/gmail";
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
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
  });
  const { saved, error } = await searchParams;
  // Which mailbox is actually sending. The address on the Company record is
  // presentation; this is the one Gmail will put on the envelope.
  const mailbox = await connectedMailbox(scope.companyId);

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
    // Unchecked boxes submit nothing, so absence is the "off" value.
    const bankAutoLinkEnabled = formData.get("bankAutoLinkEnabled") === "1";

    const emailFromName = String(formData.get("emailFromName") || "").trim();
    const emailReplyTo = String(formData.get("emailReplyTo") || "").trim();
    // Deliberately loose, and only when something was typed. An address is
    // proven by mail reaching it, not by a regular expression — but a value
    // with no "@" in it is a typo every time, and a bad Reply-To silently
    // sends every reply nowhere.
    if (emailReplyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailReplyTo)) {
      redirect("/settings/company?error=replyTo");
    }

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
        bankAutoLinkEnabled,
        // Empty clears the field rather than storing "", so the fallbacks in
        // the send path see null and use the company name.
        emailFromName: emailFromName || null,
        emailReplyTo: emailReplyTo || null,
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
        bankAutoLinkEnabled,
        emailFromName: emailFromName || null,
        emailReplyTo: emailReplyTo || null,
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
        {error === "replyTo" ? (
          <Alert tone="error">That reply-to address does not look like an email address.</Alert>
        ) : null}
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
          <fieldset className="space-y-4 border-t border-slate-200 pt-4 dark:border-slate-700">
            <legend className="text-sm font-semibold">Sending documents by email</legend>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Work orders, invoices and receipts go out from this company&rsquo;s own mailbox, so
              they appear in its Sent folder and replies reach a person.
            </p>

            {/* The connection is the fact; these fields are presentation. Shown
                first because "which address is sending" is the question someone
                opens this section to answer. */}
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/50">
              {mailbox ? (
                <>
                  <p className="font-medium text-slate-900 dark:text-white">
                    Sending as {mailbox.emailAddress}
                  </p>
                  {mailbox.needsReconnectAt ? (
                    <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                      Google has stopped accepting this connection — reconnect it before the next
                      send.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="font-medium text-amber-700 dark:text-amber-400">
                  No mailbox connected — nothing can be emailed yet.
                </p>
              )}
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                The sending address is whichever Google account is connected; Gmail will not send
                as an address it does not own.{" "}
                <Link href="/settings/email" className="underline">
                  {mailbox ? "Change or reconnect it" : "Connect a mailbox"}
                </Link>
              </p>
            </div>

            <Field
              label="Sender name"
              hint="What the recipient sees beside the address. Blank uses the company name."
            >
              <Input
                name="emailFromName"
                defaultValue={company.emailFromName ?? ""}
                placeholder={company.name}
              />
            </Field>

            <Field
              label="Reply-to address"
              hint="Where replies go, if not the sending mailbox. Use this to collect replies at an address the app cannot send from."
            >
              <Input
                name="emailReplyTo"
                type="email"
                defaultValue={company.emailReplyTo ?? ""}
                placeholder={mailbox?.emailAddress ?? "accounts@yourcompany.com"}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-700">
            <legend className="text-sm font-semibold">Run without asking</legend>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Off until you turn it on, and logged in the audit trail. Nothing here emails
              anyone: work orders and invoices reach people only when someone presses send.
            </p>

            <label className="flex gap-3 text-sm">
              <input
                type="checkbox"
                name="bankAutoLinkEnabled"
                value="1"
                defaultChecked={company.bankAutoLinkEnabled}
                className="mt-1 h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-600"
              />
              <span>
                <strong>Link the obvious bank lines.</strong> Only where exactly one recorded
                payment matches the amount on the same day. It posts nothing — it points the
                bank line at a payment already in the books — and unmatching undoes it.
                Settling and categorising stay manual.
              </span>
            </label>
          </fieldset>

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
