import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ExpenseKind, RecurringFrequency } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import {
  firstRunDate,
  generateBillOccurrence,
  upcomingBills,
  whyTemplateCannotRun,
} from "@/lib/payables/recurring-bills";
import { operatingToday } from "@/lib/invoices/recurring";
import { money, parseMoney } from "@/lib/money";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
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

export const metadata = { title: pageTitle("Recurring bills") };

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
 * Everything both create and edit read from the form, validated once.
 *
 * Module scope, not a closure inside the component: a server action that
 * captures a plain function fails at runtime with "Functions cannot be passed
 * directly to Client Components", because Next tries to serialise it. Nothing
 * here needs component state, so `baseCurrency` is passed in.
 */
function readForm(formData: FormData, back: string, baseCurrency: string) {
  const name = String(formData.get("name") || "").trim();
  if (!name) failTo(back, "Give the template a name");

  const kind: ExpenseKind = String(formData.get("kind")) === "DIRECT" ? "DIRECT" : "BILL";

  const vendorId = String(formData.get("vendorId") || "") || null;
  if (kind === "BILL" && !vendorId) failTo(back, "A bill needs a vendor — that is who you owe");

  const amount = parseMoney(String(formData.get("amount") || ""));
  if (!amount || amount.lessThanOrEqualTo(0)) failTo(back, "Enter an amount above zero");

  const description = String(formData.get("description") || "").trim();
  if (!description) failTo(back, "Say what the expense is for");

  const expenseAccountId = String(formData.get("expenseAccountId") || "");
  if (!expenseAccountId) failTo(back, "Pick an expense account");

  const paymentAccountId =
    kind === "DIRECT" ? String(formData.get("paymentAccountId") || "") || null : null;
  if (kind === "DIRECT" && !paymentAccountId) {
    failTo(back, "A direct expense needs an account to be paid from");
  }

  const frequency = String(formData.get("frequency")) as RecurringFrequency;
  const startDate = parseAccountingDate(String(formData.get("startDate") || ""));
  if (!startDate) failTo(back, "Give the schedule a start date");

  const endDate = parseAccountingDate(String(formData.get("endDate") || ""));
  const limitRaw = String(formData.get("occurrenceLimit") || "").trim();
  const occurrenceLimit = limitRaw ? Number(limitRaw) : null;
  if (occurrenceLimit !== null && (!Number.isInteger(occurrenceLimit) || occurrenceLimit < 1)) {
    failTo(back, "An occurrence limit must be a whole number of bills");
  }

  const termsRaw = String(formData.get("paymentTermsDays") || "30").trim();
  const paymentTermsDays = Number(termsRaw || 30);
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0) {
    failTo(back, "Payment terms must be a whole number of days");
  }

  const dayOfMonth = Number(formData.get("dayOfMonth") || startDate!.getUTCDate());

  return {
    name,
    kind,
    vendorId,
    amount: amount!.toFixed(2),
    description,
    reference: String(formData.get("reference") || "").trim() || null,
    expenseAccountId,
    paymentAccountId,
    frequency,
    startDate: startDate!,
    endDate,
    occurrenceLimit,
    paymentTermsDays,
    dayOfMonth,
    currency: String(formData.get("currency") || baseCurrency).toUpperCase(),
    fxRate: parseMoney(String(formData.get("fxRate") || "1"))?.toString() ?? "1",
    monthOfYear: startDate!.getUTCMonth() + 1,
  };
}


/**
 * Recurring bills (SPEC §8.2a). A template plus a schedule; the hourly job
 * records them in each company's own time zone, from 06:00 local.
 *
 * Unlike a recurring invoice, which leaves a draft, this posts. A bill goes to
 * nobody — it records what is owed — and the point of the feature is that A/P
 * Aging is true on the first of the month without anyone typing the rent in.
 * A wrong one is reversed and reposted like any other bill.
 */
export default async function RecurringBillsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    ran?: string;
    next?: string;
    edit?: string;
    deleted?: string;
  }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;

  const [company, templates, vendors, expenseAccounts, paymentAccounts, upcoming] =
    await Promise.all([
      prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
      prisma.recurringBillTemplate.findMany({
        where: scope.where,
        include: { vendor: { select: { name: true } } },
        orderBy: [{ isPaused: "asc" }, { nextRunDate: "asc" }],
      }),
      prisma.vendor.findMany({
        // Regular vendors only, like the Expenses list: a consultant's bill
        // belongs to the Consultants section.
        where: { ...scope.where, kind: "REGULAR", isActive: true },
        orderBy: { name: "asc" },
      }),
      prisma.account.findMany({
        where: { ...scope.where, isActive: true, type: "EXPENSE" },
        orderBy: { code: "asc" },
      }),
      prisma.account.findMany({
        where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
        orderBy: { code: "asc" },
      }),
      upcomingBills({ companyId: scope.companyId, from: today(), days: 30 }),
    ]);

  const editing = params.edit
    ? (templates.find((template) => template.id === params.edit) ?? null)
    : null;

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const back = "/expenses/recurring";
    const form = readForm(formData, back, company.baseCurrency);

    // Prove the accounts and the vendor belong to this company: the form is
    // not the guard, and a stale page could name something from elsewhere.
    const [expenseAccount, vendor] = await Promise.all([
      prisma.account.findFirst({
        where: { id: form.expenseAccountId, companyId: inner.companyId, isActive: true },
      }),
      form.vendorId
        ? prisma.vendor.findFirst({ where: { id: form.vendorId, companyId: inner.companyId } })
        : null,
    ]);
    if (!expenseAccount) failTo(back, "Expense account not found in this company");
    if (form.vendorId && !vendor) failTo(back, "Vendor not found in this company");

    const template = await prisma.recurringBillTemplate.create({
      data: {
        companyId: inner.companyId,
        name: form.name,
        kind: form.kind,
        vendorId: form.vendorId,
        frequency: form.frequency,
        dayOfMonth: form.dayOfMonth,
        monthOfYear: form.monthOfYear,
        startDate: form.startDate,
        endDate: form.endDate,
        occurrenceLimit: form.occurrenceLimit,
        // The first occurrence on or after the start date, so a template set
        // up mid-month does not immediately fire for a date already gone.
        nextRunDate: firstRunDate(form, form.startDate),
        currency: form.currency,
        fxRate: form.fxRate,
        amount: form.amount,
        expenseAccountId: form.expenseAccountId,
        paymentAccountId: form.paymentAccountId,
        paymentTermsDays: form.paymentTermsDays,
        description: form.description,
        reference: form.reference,
      },
    });

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "recurringBill.created",
      entityType: "RecurringBillTemplate",
      entityId: template.id,
      summary: `${form.name} — ${form.frequency.toLowerCase()} ${form.kind === "BILL" ? "bill" : "direct expense"} of ${form.amount} ${form.currency}`,
    });
    redirect("/expenses/recurring?saved=1");
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("templateId"));
    const back = `/expenses/recurring?edit=${id}`;
    const form = readForm(formData, back, company.baseCurrency);

    const existing = await prisma.recurringBillTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!existing) failTo("/expenses/recurring", "Template not found");

    // The schedule may have moved, so recompute where it goes next — but never
    // backwards past what has already run, or the job would try to record a
    // period whose (templateId, scheduledDate) row is already claimed and
    // report a string of ALREADY_RUNs.
    const recomputed = firstRunDate(form, form.startDate);
    const floor = existing!.lastRunDate
      ? new Date(existing!.lastRunDate.getTime() + 86_400_000)
      : form.startDate;
    const nextRunDate = firstRunDate(form, recomputed > floor ? recomputed : floor);

    await prisma.recurringBillTemplate.update({
      where: { id },
      data: {
        name: form.name,
        // The kind is fixed after creation, like an expense's: switching moves
        // money between accounts that mean very different things.
        vendorId: form.vendorId,
        frequency: form.frequency,
        dayOfMonth: form.dayOfMonth,
        monthOfYear: form.monthOfYear,
        startDate: form.startDate,
        endDate: form.endDate,
        occurrenceLimit: form.occurrenceLimit,
        nextRunDate,
        currency: form.currency,
        fxRate: form.fxRate,
        amount: form.amount,
        expenseAccountId: form.expenseAccountId,
        paymentAccountId: existing!.kind === "DIRECT" ? form.paymentAccountId : null,
        paymentTermsDays: form.paymentTermsDays,
        description: form.description,
        reference: form.reference,
      },
    });

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "recurringBill.updated",
      entityType: "RecurringBillTemplate",
      entityId: id,
      summary: `${form.name} — next on ${formatAccountingDate(nextRunDate)}`,
    });
    redirect("/expenses/recurring?saved=1");
  }

  async function togglePause(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("templateId"));
    const template = await prisma.recurringBillTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!template) failTo("/expenses/recurring", "Template not found");

    await prisma.recurringBillTemplate.update({
      where: { id },
      data: { isPaused: !template!.isPaused },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: template!.isPaused ? "recurringBill.resumed" : "recurringBill.paused",
      entityType: "RecurringBillTemplate",
      entityId: id,
    });
    redirect("/expenses/recurring?saved=1");
  }

  async function remove(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("templateId"));
    const template = await prisma.recurringBillTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!template) failTo("/expenses/recurring", "Template not found");

    // Deleting the template deletes its run history with it, and leaves every
    // bill it already recorded exactly where it is. Those are real postings;
    // the schedule that produced them is not.
    await prisma.recurringBillTemplate.delete({ where: { id } });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "recurringBill.deleted",
      entityType: "RecurringBillTemplate",
      entityId: id,
      summary: `Deleted the schedule "${template!.name}" — the bills it recorded are untouched`,
    });
    redirect("/expenses/recurring?deleted=1");
  }

  async function runNow(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("templateId"));
    const template = await prisma.recurringBillTemplate.findFirst({
      where: { id, companyId: inner.companyId },
    });
    if (!template) failTo("/expenses/recurring", "Template not found");

    // "Run now" catches up what is owed; it does not pull the future forward.
    // Without this, two clicks on the 21st quietly record next month's rent
    // too, because the first run has already advanced nextRunDate.
    const inner2 = await prisma.company.findFirstOrThrow({
      where: { id: inner.companyId },
      select: { operatingTimeZone: true },
    });
    if (template!.nextRunDate > operatingToday(new Date(), inner2.operatingTimeZone)) {
      redirect(`/expenses/recurring?ran=NOT_DUE&next=${isoDate(template!.nextRunDate)}`);
    }

    // The *scheduled* date, not today: running early must not change which
    // period the bill belongs to, and it must collide with the scheduled run
    // rather than duplicating it.
    const result = await generateBillOccurrence({
      templateId: id,
      scheduledDate: template!.nextRunDate,
    });
    redirect(
      `/expenses/recurring?ran=${encodeURIComponent(result.status)}${
        result.reason ? `&next=${encodeURIComponent(result.reason)}` : ""
      }`,
    );
  }

  const ranMessage: Record<string, string> = {
    RECORDED: "Recorded and posted. It is on the Expenses list now.",
    ALREADY_RUN: "That date had already been recorded — nothing was duplicated.",
    SKIPPED: `Nothing recorded: ${params.next ?? "the schedule had already finished"}.`,
    NOT_DUE: `Nothing due yet — the next one falls on ${
      params.next ? formatAccountingDate(new Date(params.next)) : "a later date"
    }.`,
  };

  const editKind = editing?.kind ?? null;

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Recurring bills"
          description="A template plus a schedule. Rent, a retainer, a utility — recorded and posted on its date, in this company's own time zone."
        />
        <Link href="/expenses">
          <Button variant="secondary">Expenses and bills</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.deleted ? (
        <Alert tone="success">
          Schedule deleted. The bills it already recorded are untouched — they are real
          postings.
        </Alert>
      ) : null}
      {params.ran ? (
        <Alert tone={params.ran === "RECORDED" ? "success" : "info"}>
          {ranMessage[params.ran] ?? params.ran}
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* min-w-0 for the same reason Card carries it: a grid item will not
            shrink below its widest child, so a scrollable table inside pushes
            the page sideways on a phone. */}
        <div className="min-w-0 space-y-6">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Templates</h2>
            {templates.length === 0 ? (
              <EmptyState title="No recurring bills yet">
                Set one up for the rent or a monthly retainer and it will be recorded on
                schedule, so what you owe is right without anyone typing it in.
              </EmptyState>
            ) : (
              <DataTable>
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-4">Template</th>
                    <th className="py-2 pr-4">Vendor</th>
                    <th className="py-2 pr-4">Every</th>
                    <th className="py-2 pr-4">Next</th>
                    <th className="py-2 pr-4 text-right">Amount</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {templates.map((template) => {
                    const unusable = whyTemplateCannotRun(template);
                    return (
                      <tr
                        key={template.id}
                        className="border-b border-slate-100 dark:border-slate-800/60"
                      >
                        <td className="py-2 pr-4">
                          {template.name}
                          {template.isPaused ? (
                            <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                              paused
                            </span>
                          ) : null}
                          <div className="text-xs text-slate-500">
                            {template.kind === "BILL"
                              ? `bill · due ${template.paymentTermsDays} days after`
                              : "direct expense · paid on the day"}
                            {template.occurrenceLimit
                              ? ` · ${template.occurrenceCount}/${template.occurrenceLimit} recorded`
                              : ""}
                          </div>
                          {unusable ? (
                            // Said here rather than left to fail at 06:00, when
                            // nobody is watching the job's output.
                            <div className="text-xs text-red-700 dark:text-red-300">
                              Will not run: {unusable.toLowerCase()}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-2 pr-4">{template.vendor?.name ?? "—"}</td>
                        <td className="py-2 pr-4 text-xs">
                          {FREQUENCY_LABELS[template.frequency]}
                        </td>
                        <td className="py-2 pr-4 text-xs tabular-nums">
                          {template.isPaused ? "—" : formatAccountingDate(template.nextRunDate)}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">
                          {formatMoney(money(template.amount).toFixed(2), template.currency)}
                        </td>
                        <td className="py-2 text-right">
                          <div className="flex justify-end gap-1">
                            <Link
                              href={`/expenses/recurring?edit=${template.id}`}
                              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              Edit
                            </Link>
                            <form action={runNow}>
                              <input type="hidden" name="templateId" value={template.id} />
                              <Button variant="ghost" type="submit">
                                Run now
                              </Button>
                            </form>
                            <form action={togglePause}>
                              <input type="hidden" name="templateId" value={template.id} />
                              <Button variant="ghost" type="submit">
                                {template.isPaused ? "Resume" : "Pause"}
                              </Button>
                            </form>
                            <form action={remove}>
                              <input type="hidden" name="templateId" value={template.id} />
                              <Button
                                variant="ghost"
                                type="submit"
                                className="text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950"
                              >
                                Delete
                              </Button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-sm font-semibold">Coming in the next 30 days</h2>
            {upcoming.some((row) => row.date < today()) ? (
              <Alert tone="warning">
                Some dates below have already passed. They are still listed because nothing has
                been recorded for them — the scheduler may not be running.
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
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Template</th>
                    <th className="py-2 pr-4">Vendor</th>
                    <th className="py-2 pr-4">What happens</th>
                    <th className="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((row) => (
                    <tr
                      key={`${row.templateId}-${isoDate(row.date)}`}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2 pr-4 tabular-nums">
                        {formatAccountingDate(row.date)}
                        {row.date < today() ? (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            overdue
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4">{row.templateName}</td>
                      <td className="py-2 pr-4 text-slate-500">{row.vendorName ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs">
                        {row.kind === "BILL" ? "post to accounts payable" : "pay from the bank"}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(money(row.amount).toFixed(2), row.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </Card>
        </div>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">
            {editing ? `Edit ${editing.name}` : "New recurring bill"}
          </h2>
          <form action={editing ? save : create} className="space-y-4">
            {editing ? <input type="hidden" name="templateId" value={editing.id} /> : null}

            <Field label="Name" hint="What this is, in the list — “Office rent”, not a number.">
              <Input name="name" defaultValue={editing?.name ?? ""} required />
            </Field>

            <Field
              label="Records a"
              hint={
                editing
                  ? "Fixed after creation: switching moves money between very different accounts."
                  : "A bill is owed and cleared later. A direct expense leaves the bank on the day."
              }
            >
              <Select
                name="kind"
                defaultValue={editKind ?? "BILL"}
                disabled={Boolean(editing)}
              >
                <option value="BILL">Bill — owed, paid later</option>
                <option value="DIRECT">Direct expense — paid on the day</option>
              </Select>
            </Field>
            {/* A disabled select submits nothing, so the kind rides along. */}
            {editing ? <input type="hidden" name="kind" value={editing.kind} /> : null}

            <Field label="Vendor" hint="Required for a bill — that is who you owe.">
              <Select name="vendorId" defaultValue={editing?.vendorId ?? ""}>
                <option value="">None</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Description">
              <Input name="description" defaultValue={editing?.description ?? ""} required />
            </Field>

            <Field label="Reference">
              <Input name="reference" defaultValue={editing?.reference ?? ""} />
            </Field>

            <Field label="Amount">
              <Input
                name="amount"
                inputMode="decimal"
                defaultValue={editing ? money(editing.amount).toFixed(2) : ""}
                required
              />
            </Field>

            <Field label="Expense account">
              <Select name="expenseAccountId" defaultValue={editing?.expenseAccountId ?? ""}>
                {expenseAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>

            {(editKind ?? "BILL") === "DIRECT" ? (
              <Field label="Paid from">
                <Select name="paymentAccountId" defaultValue={editing?.paymentAccountId ?? ""}>
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              // Rendered for a new template too, because the kind is chosen in
              // the same submission and a bill simply ignores it.
              <Field
                label="Paid from"
                hint="Only used by a direct expense. A bill is cleared through Bill payments."
              >
                <Select name="paymentAccountId" defaultValue={paymentAccounts[0]?.id ?? ""}>
                  {paymentAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Currency">
                <Input
                  name="currency"
                  defaultValue={editing?.currency ?? company.baseCurrency}
                  maxLength={3}
                />
              </Field>
              <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
                <Input
                  name="fxRate"
                  inputMode="decimal"
                  defaultValue={editing ? money(editing.fxRate).toString() : "1"}
                />
              </Field>
            </div>

            <Field label="Every">
              <Select name="frequency" defaultValue={editing?.frequency ?? "MONTHLY"}>
                {FREQUENCIES.map((frequency) => (
                  <option key={frequency.value} value={frequency.value}>
                    {frequency.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Starting">
                <Input
                  type="date"
                  name="startDate"
                  defaultValue={isoDate(editing?.startDate ?? today())}
                  required
                />
              </Field>
              <Field label="On day" hint="Clamped: “the 31st” lands on 28 February.">
                <Input
                  type="number"
                  name="dayOfMonth"
                  min={1}
                  max={31}
                  defaultValue={editing?.dayOfMonth ?? ""}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Ending" hint="Optional.">
                <Input
                  type="date"
                  name="endDate"
                  defaultValue={editing?.endDate ? isoDate(editing.endDate) : ""}
                />
              </Field>
              <Field label="Stop after" hint="Optional, a number of bills.">
                <Input
                  type="number"
                  name="occurrenceLimit"
                  min={1}
                  defaultValue={editing?.occurrenceLimit ?? ""}
                />
              </Field>
            </div>

            <Field label="Payment terms (days)" hint="Ignored by a direct expense.">
              <Input
                type="number"
                name="paymentTermsDays"
                min={0}
                defaultValue={editing?.paymentTermsDays ?? 30}
              />
            </Field>

            <div className="flex justify-end gap-2">
              {editing ? (
                <Link
                  href="/expenses/recurring"
                  className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </Link>
              ) : null}
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
