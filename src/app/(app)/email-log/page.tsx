import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { isoDate } from "@/lib/dates";
import { operatingToday } from "@/lib/invoices/recurring";
import { periodInstantWhere, resolvePeriod } from "@/lib/reports/date-filter";
import { PeriodFilter } from "@/components/period-filter";
import { FilterSelect } from "@/components/filter-select";
import { FilterText } from "@/components/filter-text";
import {
  Alert,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";

export const metadata = { title: pageTitle("Email log") };

const STATUS_STYLES: Record<string, string> = {
  QUEUED: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  SENT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "SENT", label: "Sent" },
  { value: "FAILED", label: "Failed" },
  { value: "QUEUED", label: "Queued" },
];

/** SPEC §10: every attempt, filterable by document and by batch. */
export default async function EmailLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    relatedId?: string;
    batch?: string;
    status?: string;
    name?: string;
    sentTo?: string;
    subject?: string;
    period?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const scope = await companyScope();
  scope.requireRole("OWNER", "BOOKKEEPER");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
  });

  /**
   * The period runs on the company's own clock, because the When column is
   * stamped on it: a Manila evening is still today here, and a UTC day would
   * put the same message under two different dates in two places.
   */
  const period = resolvePeriod(
    params,
    operatingToday(new Date(), company.operatingTimeZone),
    company.fiscalYearStartMonth,
  );

  const name = (params.name ?? "").trim();
  // `sentTo`, not `to`: the period filter already owns `to` on every list
  // screen in the app, and one parameter cannot mean both a date and an
  // address.
  const recipient = (params.sentTo ?? "").trim();
  const subject = (params.subject ?? "").trim();

  const page = readPage(params);
  const logWhere = {
    ...scope.where,
    ...(params.relatedId ? { relatedId: params.relatedId } : {}),
    ...(params.batch ? { emailBatchId: params.batch } : {}),
    ...(params.status
      ? { status: params.status as "QUEUED" | "SENT" | "FAILED" }
      : {}),
    ...periodInstantWhere(period, "createdAt", company.operatingTimeZone),
    ...(name
      ? { recipientName: { contains: name, mode: "insensitive" as const } }
      : {}),
    // The To column shows the cc line underneath, so searching it searches
    // both: looking for your own cc'd address and finding nothing would be
    // the screen contradicting itself.
    ...(recipient
      ? {
          recipientsText: { contains: recipient, mode: "insensitive" as const },
        }
      : {}),
    ...(subject
      ? { subject: { contains: subject, mode: "insensitive" as const } }
      : {}),
  };

  const logs = await prisma.emailLog.findMany({
    where: logWhere,
    orderBy: { createdAt: "desc" },
    skip: page.skip,
    take: page.take,
  });

  const total = await prisma.emailLog.count({ where: logWhere });
  const summary = pageSummary(page, total, "message");

  const dryRunCount = logs.filter(
    (log) => log.gmailMessageId === "dry-run",
  ).length;

  const filtering = Boolean(
    period.active || name || recipient || subject || params.status,
  );
  const carried = {
    ...(params.relatedId ? { relatedId: params.relatedId } : {}),
    ...(params.batch ? { batch: params.batch } : {}),
  };

  return (
    <>
      <PageHeader
        title="Email log"
        description="Every attempt, whether it succeeded, failed or was a dry run."
      />

      <Card className="mb-4">
        <PeriodFilter
          label="Sent"
          value={period.key}
          from={period.from ? isoDate(period.from) : ""}
          to={period.to ? isoDate(period.to) : ""}
          carry={carried}
        >
          <FilterText
            name="name"
            label="Name"
            value={name}
            placeholder="Consultant, vendor…"
          />
          <FilterText
            name="sentTo"
            label="Sent to"
            value={recipient}
            placeholder="Part of an address"
          />
          <FilterText
            name="subject"
            label="Subject contains"
            value={subject}
            placeholder="WO1003"
          />
          <FilterSelect
            name="status"
            label="Status"
            value={params.status ?? ""}
            options={STATUS_OPTIONS}
          />
        </PeriodFilter>
        {filtering ? (
          <p className="mt-3 text-xs text-slate-500">
            Showing {summary.total} of the log.{" "}
            <Link
              className="underline"
              href={`/email-log${
                Object.keys(carried).length
                  ? `?${new URLSearchParams(carried).toString()}`
                  : ""
              }`}
            >
              Clear the filters
            </Link>
          </p>
        ) : null}
      </Card>

      {dryRunCount > 0 ? (
        <Alert tone="warning">
          {dryRunCount} of these were dry runs — logged, never actually sent.
        </Alert>
      ) : null}

      {logs.length === 0 ? (
        filtering ? (
          <EmptyState
            title="No messages match these filters"
            action={{ href: "/email-log", label: "Show the whole log" }}
          >
            Nothing was sent to that name or address in that period, or the
            subject does not contain what you typed. Widening the period is
            usually the one that finds it.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing sent yet">
            Every attempt lands here — successes and failures alike, with the
            reason a message was refused. Send an invoice or a work order and it
            will show up.
          </EmptyState>
        )
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">When</th>
                <th className="py-2">Name</th>
                <th className="py-2">To</th>
                <th className="py-2">Subject</th>
                <th className="py-2">Attachments</th>
                <th className="py-2">Document</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  className="border-b border-slate-100 dark:border-slate-800/60"
                >
                  <td className="py-2 whitespace-nowrap">
                    {formatDateTimeInZone(
                      log.createdAt,
                      company.operatingTimeZone,
                    )}
                  </td>
                  <td className="py-2">
                    {log.recipientName ? (
                      // One click to see everything else that went to them.
                      <Link
                        className="underline decoration-dotted underline-offset-2"
                        href={`/email-log?name=${encodeURIComponent(log.recipientName)}`}
                      >
                        {log.recipientName}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    {log.toAddresses.join(", ") || (
                      <span className="text-slate-400">—</span>
                    )}
                    {log.cc.length > 0 ? (
                      <div className="text-xs text-slate-500">
                        cc {log.cc.join(", ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="py-2">{log.subject}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {log.attachmentNames.join(", ") || "—"}
                  </td>
                  <td className="py-2 text-xs">
                    {log.relatedType === "Invoice" && log.relatedId ? (
                      <Link
                        className="underline"
                        href={`/invoices/${log.relatedId}`}
                      >
                        invoice
                      </Link>
                    ) : log.relatedType === "WorkOrder" && log.relatedId ? (
                      <Link
                        className="underline"
                        href={`/work-orders/${log.relatedId}`}
                      >
                        work order
                      </Link>
                    ) : log.relatedType === "PurchaseOrder" && log.relatedId ? (
                      <Link
                        className="underline"
                        href={`/purchase-orders/${log.relatedId}`}
                      >
                        purchase order
                      </Link>
                    ) : (
                      (log.relatedType ?? "—")
                    )}
                  </td>
                  <td className="py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        STATUS_STYLES[log.status]
                      }`}
                    >
                      {log.gmailMessageId === "dry-run"
                        ? "dry run"
                        : log.status.toLowerCase()}
                    </span>
                    {log.error ? (
                      <div className="mt-1 max-w-sm text-xs text-red-600 dark:text-red-400">
                        {log.error}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
          <Pagination
            summary={summary}
            previousHref={pageHref("/email-log", params, page.page - 1)}
            nextHref={pageHref("/email-log", params, page.page + 1)}
          />
        </Card>
      )}
    </>
  );
}
