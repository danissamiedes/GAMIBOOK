import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { RecurringFrequency, RecurringMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import {
  generateOccurrence,
  occurrenceOnOrAfter,
  operatingToday,
  upcomingOccurrences,
} from "@/lib/invoices/recurring";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { DocumentLineEditor } from "@/components/document-line-editor";
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

export const metadata = { title: pageTitle("Recurring invoices") };

const FREQUENCIES: { value: RecurringFrequency; label: string }[] = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every two weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "ANNUALLY", label: "Annually" },
];

const FREQUENCY_LABELS = Object.fromEntries(
  FREQUENCIES.map((frequency) => [frequency.value, frequency.label]),
) as Record<RecurringFrequency, string>;

/**
 * Recurring invoices (SPEC §7.2). A template plus a schedule; the daily job
 * turns them into invoices.
 *
 * Templates default to leaving a draft. Auto-sending is per template and opt
 * in, because an invoice that posts revenue and reaches a customer without
 * anyone reading it is a different kind of mistake from a wrong draft.
 */
export default async function RecurringInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    ran?: string;
    next?: string;
  }>;
}) {
  const scope = await sectionScope("SALES");
  const params = await searchParams;

  const [company, templates, customers, accounts, upcoming] = await Promise.all(
    [
      prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
      prisma.recurringInvoiceTemplate.findMany({
        where: scope.where,
        include: { customer: { select: { name: true } }, lines: true },
        orderBy: [{ isPaused: "asc" }, { nextRunDate: "asc" }],
      }),
      prisma.customer.findMany({
        where: { ...scope.where, isActive: true },
        orderBy: { name: "asc" },
      }),
      prisma.account.findMany({
        where: { ...scope.where, isActive: true, type: "INCOME" },
        orderBy: { code: "asc" },
      }),
      upcomingOccurrences({
        companyId: scope.companyId,
        from: today(),
        days: 30,
      }),
    ],
  );

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const back = "/invoices/recurring";

    const name = String(formData.get("name") || "").trim();
    if (!name) failTo(back, "Give the template a name");

    const customerId = String(formData.get("customerId") || "");
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, companyId: inner.companyId },
    });
    if (!customer) failTo(back, "Pick a customer");

    const frequency = String(formData.get("frequency")) as RecurringFrequency;
    const startDate = parseAccountingDate(
      String(formData.get("startDate") || ""),
    );
    if (!startDate) failTo(back, "Give the schedule a start date");

    const lineCount = Number(formData.get("lineCount") ?? 0);
    const lines = [];
    for (let index = 0; index < lineCount; index += 1) {
      const description = String(
        formData.get(`line-${index}-description`) || "",
      ).trim();
      const quantity = parseMoney(
        String(formData.get(`line-${index}-quantity`) || ""),
      );
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      const incomeAccountId = String(
        formData.get(`line-${index}-accountId`) || "",
      );
      if (!description || !quantity || !rate || !incomeAccountId) continue;
      lines.push({
        lineNumber: lines.length + 1,
        description,
        quantity: quantity.toFixed(4),
        rate: rate.toFixed(6),
        incomeAccountId,
      });
    }
    if (lines.length === 0) failTo(back, "A template needs at least one line");

    const endDate = parseAccountingDate(String(formData.get("endDate") || ""));
    const limitRaw = String(formData.get("occurrenceLimit") || "").trim();
    const occurrenceLimit = limitRaw ? Number(limitRaw) : null;
    if (
      occurrenceLimit !== null &&
      (!Number.isInteger(occurrenceLimit) || occurrenceLimit < 1)
    ) {
      failTo(back, "An occurrence limit must be a whole number of invoices");
    }

    const dayOfMonth = Number(
      formData.get("dayOfMonth") || startDate!.getUTCDate(),
    );
    const schedule = {
      frequency,
      startDate: startDate!,
      dayOfMonth,
      monthOfYear: startDate!.getUTCMonth() + 1,
    };

    const template = await prisma.recurringInvoiceTemplate.create({
      data: {
        companyId: inner.companyId,
        customerId: customer!.id,
        name,
        frequency,
        dayOfMonth,
        monthOfYear: startDate!.getUTCMonth() + 1,
        startDate: startDate!,
        endDate,
        occurrenceLimit,
        // The first occurrence on or after the start date, so a template
        // created mid-month does not immediately fire for a date gone by.
        nextRunDate: occurrenceOnOrAfter(schedule, startDate!),
        mode: (String(formData.get("mode")) as RecurringMode) ?? "CREATE_DRAFT",
        currency: customer!.defaultCurrency,
        paymentTermsDays: customer!.paymentTermsDays,
        memo: String(formData.get("memo") || "").trim() || null,
        lines: { create: lines },
      },
    });

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "recurringTemplate.created",
      entityType: "RecurringInvoiceTemplate",
      entityId: template.id,
      summary: `${name} — ${frequency.toLowerCase()} for ${customer!.name}`,
    });
    redirect("/invoices/recurring?saved=1");
  }

  async function togglePause(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const id = String(formData.get("templateId"));
    const template = await prisma.recurringInvoiceTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!template) failTo("/invoices/recurring", "Template not found");
    await prisma.recurringInvoiceTemplate.update({
      where: { id },
      data: { isPaused: !template!.isPaused },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: template!.isPaused
        ? "recurringTemplate.resumed"
        : "recurringTemplate.paused",
      entityType: "RecurringInvoiceTemplate",
      entityId: id,
    });
    redirect("/invoices/recurring?saved=1");
  }

  async function runNow(formData: FormData) {
    "use server";
    const inner = await sectionScope("SALES");
    const id = String(formData.get("templateId"));
    const template = await prisma.recurringInvoiceTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!template) failTo("/invoices/recurring", "Template not found");

    // "Run now" catches up what is owed; it does not pull the future forward.
    // Without this, clicking twice on the 21st quietly invoices September too,
    // because the first run has already advanced nextRunDate.
    const company = await prisma.company.findFirstOrThrow({
      where: { id: inner.companyId },
      select: { operatingTimeZone: true },
    });
    if (
      template!.nextRunDate >
      operatingToday(new Date(), company.operatingTimeZone)
    ) {
      redirect(
        `/invoices/recurring?ran=NOT_DUE&next=${formatAccountingDate(template!.nextRunDate)}`,
      );
    }

    // The *scheduled* date, not today: running early must not change which
    // period the invoice belongs to, and it must collide with the scheduled
    // run rather than duplicating it.
    const result = await generateOccurrence({
      templateId: id,
      scheduledDate: template!.nextRunDate,
    });
    redirect(`/invoices/recurring?ran=${encodeURIComponent(result.status)}`);
  }

  const ranMessage: Record<string, string> = {
    CREATED: "Draft invoice generated.",
    ISSUED: "Invoice generated and issued.",
    ALREADY_RUN:
      "That date had already been generated — nothing was duplicated.",
    SKIPPED: "Nothing generated: the schedule had already finished.",
    NOT_DUE: `Nothing due yet — the next one falls on ${params.next ?? "a later date"}.`,
  };

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Recurring invoices"
          description="A template plus a schedule. The daily job generates them in each company's own time zone."
        />
        <Link href="/invoices">
          <Button variant="secondary">All invoices</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.ran ? (
        <Alert tone={params.ran === "ALREADY_RUN" ? "info" : "success"}>
          {ranMessage[params.ran] ?? params.ran}
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* min-w-0 for the same reason Card carries it: a grid item defaults
            to min-width:auto and will not shrink below its widest child, so a
            scrollable table inside pushes the page sideways on a phone. */}
        <div className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Templates</h2>
            {templates.length === 0 ? (
              <EmptyState title="No recurring invoices yet">
                Set one up for a retainer client and it will be generated on
                schedule, as a draft unless you ask for it to be sent.
              </EmptyState>
            ) : (
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2">Template</th>
                    <th className="py-2">Customer</th>
                    <th className="py-2">Every</th>
                    <th className="py-2">Next</th>
                    <th className="py-2">On generation</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {templates.map((template) => (
                    <tr
                      key={template.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">
                        {template.name}
                        {template.isPaused ? (
                          <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                            paused
                          </span>
                        ) : null}
                        <div className="text-xs text-slate-500">
                          {template.lines.length} line
                          {template.lines.length === 1 ? "" : "s"} ·{" "}
                          {formatMoney(
                            template.lines
                              .reduce(
                                (total, line) =>
                                  total.plus(
                                    money(line.quantity).times(
                                      money(line.rate),
                                    ),
                                  ),
                                money(0),
                              )
                              .toFixed(2),
                            template.currency,
                          )}
                          {template.occurrenceLimit
                            ? ` · ${template.occurrenceCount}/${template.occurrenceLimit} issued`
                            : ""}
                        </div>
                      </td>
                      <td className="py-2">{template.customer.name}</td>
                      <td className="py-2 text-xs">
                        {FREQUENCY_LABELS[template.frequency]}
                      </td>
                      <td className="py-2 text-xs tabular-nums">
                        {template.isPaused
                          ? "—"
                          : formatAccountingDate(template.nextRunDate)}
                      </td>
                      <td className="py-2 text-xs">
                        {template.mode === "AUTO_SEND" ? (
                          <span className="text-amber-700 dark:text-amber-300">
                            issue and send
                          </span>
                        ) : (
                          "leave a draft"
                        )}
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <form action={runNow}>
                            <input
                              type="hidden"
                              name="templateId"
                              value={template.id}
                            />
                            <Button variant="ghost" type="submit">
                              Run now
                            </Button>
                          </form>
                          <form action={togglePause}>
                            <input
                              type="hidden"
                              name="templateId"
                              value={template.id}
                            />
                            <Button variant="ghost" type="submit">
                              {template.isPaused ? "Resume" : "Pause"}
                            </Button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">
              Coming in the next 30 days
            </h2>
            {upcoming.some((row) => row.date < today()) ? (
              <Alert tone="warning">
                Some dates below have already passed. They are still listed
                because no invoice has been generated for them — the scheduler
                may not be running.
              </Alert>
            ) : null}
            {upcoming.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nothing scheduled. A paused template contributes nothing here.
              </p>
            ) : (
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2">Date</th>
                    <th className="py-2">Template</th>
                    <th className="py-2">Customer</th>
                    <th className="py-2">What happens</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((row) => (
                    <tr
                      key={`${row.templateId}-${formatAccountingDate(row.date)}`}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2 tabular-nums">
                        {formatAccountingDate(row.date)}
                        {row.date < today() ? (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            overdue
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2">{row.templateName}</td>
                      <td className="py-2">{row.customerName}</td>
                      <td className="py-2 text-xs">
                        {row.mode === "AUTO_SEND"
                          ? "issued and sent"
                          : "draft for review"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {row.total
                          ? formatMoney(row.total.toFixed(2), row.currency)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">New template</h2>
          {customers.length === 0 ? (
            <Alert tone="info">
              Add a customer first — a recurring invoice needs somebody to bill.
            </Alert>
          ) : (
            <form action={create} className="space-y-3">
              <Field
                label="Name"
                hint="What this is, in your words — “Monthly retainer”."
              >
                <Input name="name" required />
              </Field>
              <Field
                label="Customer"
                hint="Their currency and payment terms are used."
              >
                <Select name="customerId" required>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} ({customer.defaultCurrency})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Every">
                <Select name="frequency" defaultValue="MONTHLY">
                  {FREQUENCIES.map((frequency) => (
                    <option key={frequency.value} value={frequency.value}>
                      {frequency.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Starting"
                hint="The first invoice date. Monthly schedules keep this day of the month."
              >
                <Input
                  type="date"
                  name="startDate"
                  defaultValue={formatAccountingDate(today())}
                  required
                />
              </Field>
              <Field
                label="Day of the month"
                hint="Optional. 31 still lands on the last day of a short month."
              >
                <Input
                  name="dayOfMonth"
                  inputMode="numeric"
                  placeholder="from the start date"
                />
              </Field>
              <Field label="Ending" hint="Optional.">
                <Input type="date" name="endDate" />
              </Field>
              <Field label="Stop after" hint="Optional — a number of invoices.">
                <Input name="occurrenceLimit" inputMode="numeric" />
              </Field>
              <Field
                label="On each generation"
                hint="Sending without review posts revenue and reaches the customer unread."
              >
                <Select name="mode" defaultValue="CREATE_DRAFT">
                  <option value="CREATE_DRAFT">Leave a draft for review</option>
                  <option value="AUTO_SEND">
                    Issue and send automatically
                  </option>
                </Select>
              </Field>
              <Field label="Memo" hint="Optional, copied onto every invoice.">
                <Input name="memo" />
              </Field>

              <div className="pt-2">
                <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                  Lines
                </p>
                <DocumentLineEditor
                  accounts={accounts.map((account) => ({
                    id: account.id,
                    code: account.code,
                    name: account.name,
                  }))}
                  accountLabel="Income account"
                  currency={company.baseCurrency}
                />
              </div>

              <Button type="submit">Create template</Button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
