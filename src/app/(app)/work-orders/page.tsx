import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
import { redirect } from "next/navigation";
import { approveWorkOrder, convertWorkOrdersToBills } from "@/lib/payables/work-orders";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  Pagination,
} from "@/components/ui";
import { pageHref, pageSummary, readPage } from "@/lib/pagination";
import { operatingToday } from "@/lib/invoices/recurring";
import { isoDate } from "@/lib/dates";
import { periodParams, periodWhere, resolvePeriod } from "@/lib/reports/date-filter";
import { PeriodFilter } from "@/components/period-filter";
import { FilterSelect } from "@/components/filter-select";

export const metadata = { title: pageTitle("Work orders") };

/** The status filter's options, in the order the document moves through them. */
const STATUS_OPTIONS = [
  { value: "ALL", label: "All statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "APPROVED", label: "Approved" },
  { value: "PARTIALLY_PAID", label: "Partially paid" },
  { value: "PAID", label: "Paid" },
  { value: "VOID", label: "Void" },
];

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  PARTIALLY_PAID:
    "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  VOID: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    consultant?: string;
    approved?: string;
    billed?: string;
    failed?: string;
    deleted?: string;
    page?: string;
    period?: string;
    from?: string;
    to?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  /**
   * Bulk approve (SPEC §8.3): each document posts in its own transaction, so
   * one failing — a closed period, a missing account — reports that row and
   * leaves the rest alone.
   */
  async function approveSelected(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const ids = formData.getAll("selected").map(String).filter(Boolean);
    if (ids.length === 0) redirect("/work-orders?status=DRAFT");
    if (ids.length > 500) {
      redirect(
        "/work-orders?status=DRAFT&failed=Too%20many%20at%20once%20%E2%80%94%20cap%20is%20500",
      );
    }

    let approved = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await approveWorkOrder({
          companyId: inner.companyId,
          workOrderId: id,
          userId: inner.userId,
          role: inner.role,
        });
        approved += 1;
      } catch (error) {
        failures.push(
          error instanceof PostingError ? error.message : "Unexpected error",
        );
      }
    }

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "work_order.bulk_approved",
      entityType: "WorkOrder",
      summary: `${approved} approved, ${failures.length} failed`,
    });

    redirect(
      `/work-orders?status=APPROVED&approved=${approved}${
        failures.length > 0
          ? `&failed=${encodeURIComponent(failures.slice(0, 3).join("; "))}`
          : ""
      }`,
    );
  }

  /**
   * Bulk convert to bills (SPEC §8.1b). Same shape as the bulk approve above
   * and for the same reason: each conversion posts on its own, so a work
   * order that cannot be billed names itself and leaves the rest billed.
   */
  async function convertSelected(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const ids = formData.getAll("selected").map(String).filter(Boolean);
    if (ids.length === 0) redirect("/work-orders?status=APPROVED");
    if (ids.length > 500) {
      redirect(
        "/work-orders?status=APPROVED&failed=Too%20many%20at%20once%20%E2%80%94%20cap%20is%20500",
      );
    }

    const results = await convertWorkOrdersToBills({
      companyId: inner.companyId,
      workOrderIds: ids,
      userId: inner.userId,
      role: inner.role,
    });
    const billed = results.filter((row) => row.expenseId);
    const failures = results.filter((row) => row.error);

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "work_order.bulk_billed",
      entityType: "WorkOrder",
      summary: `${billed.length} billed, ${failures.length} failed`,
    });

    redirect(
      `/consultant-bills?billed=${billed.length}${
        failures.length > 0
          ? `&failed=${encodeURIComponent(
              failures
                .slice(0, 3)
                .map((row) => `${row.number ?? "draft"}: ${row.error}`)
                .join("; "),
            )}`
          : ""
      }`,
    );
  }

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { operatingTimeZone: true, fiscalYearStartMonth: true },
  });
  // The company's own today, not UTC and not the viewer's: a Manila business
  // at nine in the evening is still on today's date.
  const period = resolvePeriod(
    params,
    operatingToday(new Date(), company.operatingTimeZone),
    company.fiscalYearStartMonth,
  );

  const page = readPage(params);
  const workOrderWhere = {
    ...scope.where,
    ...periodWhere(period, "issueDate"),
    ...(params.status && params.status !== "ALL"
      ? {
          status: params.status as
            | "DRAFT"
            | "APPROVED"
            | "PARTIALLY_PAID"
            | "PAID"
            | "VOID",
        }
      : {}),
    ...(params.consultant ? { vendorId: params.consultant } : {}),
  };

  const workOrders = await prisma.workOrder.findMany({
    where: workOrderWhere,
    include: {
      vendor: { select: { id: true, name: true } },
      lines: { select: { id: true } },
      bill: { select: { id: true, reference: true } },
    },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    skip: page.skip,
    take: page.take,
  });

  const total = await prisma.workOrder.count({ where: workOrderWhere });
  const summary = pageSummary(page, total, "work order");

  // An empty screen means one of two different things, and only one of them is
  // "you have not started yet". Asked only when it can change the answer.
  const filtering = Boolean(
    (params.status && params.status !== "ALL") || params.consultant || period.active,
  );
  const hiddenByFilter =
    workOrders.length === 0 &&
    filtering &&
    (await prisma.workOrder.count({ where: scope.where })) > 0;

  const now = today();

  // Everything a link must carry so that changing one filter does not silently
  // drop the others — which reads as the app losing your place.
  const carried = {
    ...(params.status && params.status !== "ALL" ? { status: params.status } : {}),
    ...(params.consultant ? { consultant: params.consultant } : {}),
    ...periodParams(period),
  };
  const withFilters = (over: Record<string, string>) => {
    const query = new URLSearchParams({ ...carried, ...over });
    for (const [key, value] of [...query.entries()]) if (!value) query.delete(key);
    const search = query.toString();
    return search ? `?${search}` : "";
  };

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader
          title="Work orders"
          description="What consultants are owed, and for what."
        />
        <div className="flex gap-2">
          <Link href="/work-orders/send">
            <Button variant="secondary">Send in bulk</Button>
          </Link>
          <Link href="/work-orders/import">
            <Button variant="secondary">Import from spreadsheet</Button>
          </Link>
          {/* The filters travel with the link, so the file is what is on
              screen — and unpaginated, because a spreadsheet exists precisely
              so someone can have the lot. */}
          <a href={`/work-orders/export${withFilters({})}`}>
            <Button variant="secondary">Export to Excel</Button>
          </a>
          <Link href="/work-orders/new">
            <Button>New work order</Button>
          </Link>
        </div>
      </div>

      <Card className="mb-4">
        <PeriodFilter
          label="Work order date"
          value={period.key}
          from={period.from ? isoDate(period.from) : ""}
          to={period.to ? isoDate(period.to) : ""}
          // Status is a field in this form now, not a carried param, so it is
          // not also passed as a hidden input.
          carry={{ ...(params.consultant ? { consultant: params.consultant } : {}) }}
        >
          <FilterSelect
            name="status"
            label="Status"
            value={params.status ?? "ALL"}
            options={STATUS_OPTIONS}
          />
        </PeriodFilter>
        {period.active ? (
          <p className="mt-3 text-xs text-slate-500">
            Showing {period.label.toLowerCase()}.{" "}
            <Link className="underline" href={`/work-orders${withFilters({ period: "", from: "", to: "" })}`}>
              Clear the date filter
            </Link>
          </p>
        ) : null}
      </Card>

      {params.approved ? (
        <Alert tone="success">
          {params.approved} work orders approved. Nothing has posted yet — convert them to bills
          when the cost is real.
        </Alert>
      ) : null}
      {params.billed ? (
        <Alert tone="success">{params.billed} work orders billed.</Alert>
      ) : null}
      {params.failed ? (
        <Alert tone="error">{decodeURIComponent(params.failed)}</Alert>
      ) : null}
      {params.deleted ? (
        <Alert tone="success">
          Deleted. What it was is kept in the audit trail, and its numbers stay unused.
        </Alert>
      ) : null}

      {workOrders.length === 0 ? (
        hiddenByFilter ? (
          <EmptyState
            title="No work orders match these filters"
            action={{ href: "/work-orders", label: "Show all work orders" }}
          >
            Others exist — the status, consultant or date filter is hiding them.
          </EmptyState>
        ) : (
          <EmptyState
            title="No work orders yet"
            action={{ href: "/work-orders/new", label: "New work order" }}
          >
            Raise one for a consultant, or bring a month in at once from a
            spreadsheet with{" "}
            <Link className="underline" href="/work-orders/import">
              import
            </Link>
            . Approving gives it its number; converting it to a bill is what
            puts it into accounts payable.
          </EmptyState>
        )
      ) : (
        <Card>
          <form action={approveSelected}>
            <DataTable>
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                  <th className="py-2 w-8"></th>
                  <th className="py-2">Number</th>
                  <th className="py-2">Consultant</th>
                  <th className="py-2">Date</th>
                  <th className="py-2">Due</th>
                  <th className="py-2">Lines</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Billed as</th>
                  <th className="py-2 text-right">Total</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {workOrders.map((workOrder) => {
                  // Only a work order from the old flow is itself payable, so
                  // only that one can be overdue; a new one's due date belongs
                  // to its bill (SPEC §8.1b).
                  const overdue =
                    workOrder.postedOnApproval &&
                    workOrder.dueDate < now &&
                    money(workOrder.balanceDue).greaterThan(0) &&
                    ["APPROVED", "PARTIALLY_PAID"].includes(workOrder.status);
                  const billable =
                    workOrder.status === "APPROVED" &&
                    !workOrder.postedOnApproval &&
                    !workOrder.billedAt &&
                    !workOrder.bill;
                  return (
                    <tr
                      key={workOrder.id}
                      className="border-b border-slate-100 dark:border-slate-800/60"
                    >
                      <td className="py-2">
                        {workOrder.status === "DRAFT" || billable ? (
                          <input
                            type="checkbox"
                            name="selected"
                            value={workOrder.id}
                            aria-label={`Select ${workOrder.workOrderNumber ?? "draft"}`}
                          />
                        ) : null}
                      </td>
                      <td className="py-2 font-mono text-xs">
                        <Link
                          className="underline"
                          href={`/work-orders/${workOrder.id}`}
                        >
                          {workOrder.workOrderNumber ?? "draft"}
                        </Link>
                      </td>
                      <td className="py-2">{workOrder.vendor.name}</td>
                      <td className="py-2">
                        {formatAccountingDate(workOrder.issueDate)}
                      </td>
                      <td
                        className={`py-2 ${overdue ? "text-red-600 dark:text-red-400" : ""}`}
                      >
                        {formatAccountingDate(workOrder.dueDate)}
                      </td>
                      <td className="py-2 text-slate-500">
                        {workOrder.lines.length}
                      </td>
                      <td className="py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                            STATUS_STYLES[workOrder.status]
                          }`}
                        >
                          {workOrder.status.replace("_", " ").toLowerCase()}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {workOrder.bill ? (
                          <Link className="underline" href={`/expenses/${workOrder.bill.id}`}>
                            {workOrder.bill.reference ?? "bill"}
                          </Link>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {formatMoney(
                          money(workOrder.total).toFixed(2),
                          workOrder.currency,
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {workOrder.postedOnApproval ? (
                          formatMoney(
                            money(workOrder.balanceDue).toFixed(2),
                            workOrder.currency,
                          )
                        ) : (
                          // Nothing is owed on this one: what is owed, if
                          // anything, is owed on its bill.
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
            <Pagination
              summary={summary}
              previousHref={pageHref("/work-orders", params, page.page - 1)}
              nextHref={pageHref("/work-orders", params, page.page + 1)}
            />

            {workOrders.some(
              (workOrder) =>
                workOrder.status === "DRAFT" ||
                (workOrder.status === "APPROVED" &&
                  !workOrder.postedOnApproval &&
                  !workOrder.billedAt &&
                  !workOrder.bill),
            ) ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button type="submit" variant="secondary">
                  Approve selected
                </Button>
                <Button type="submit" variant="secondary" formAction={convertSelected}>
                  Convert selected to bills
                </Button>
                <p className="text-xs text-slate-500">
                  Approving gives a draft its number. Converting puts an approved work order into
                  accounts payable as a bill, listed under consultant bills. Each is its own
                  posting — one failing does not stop the others.
                </p>
              </div>
            ) : null}
          </form>
        </Card>
      )}
    </>
  );
}
