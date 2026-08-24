import type { Prisma } from "@prisma/client";
import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { operatingToday } from "@/lib/invoices/recurring";
import { periodWhere, resolvePeriod } from "@/lib/reports/date-filter";
import {
  buildWorkOrdersWorkbook,
  workOrderFilterSummary,
  workOrdersFilename,
} from "@/lib/exports/work-orders-workbook";

const STATUSES = ["DRAFT", "APPROVED", "PARTIALLY_PAID", "PAID", "VOID"] as const;

/**
 * The work orders list, as a spreadsheet.
 *
 * Scoped exactly like the screen it comes from — the CONSULTANTS section — and
 * it reads the same status, consultant and period params the page does, so the
 * file is what is on screen. An export is the easiest place to widen access by
 * accident, because nobody watches the rows go by.
 *
 * Deliberately not paginated. The list shows a hundred at a time because a
 * screen has to stop somewhere; a spreadsheet exists precisely so someone can
 * have the lot, and a silently truncated export is worse than a slow one.
 */
export async function GET(request: Request) {
  const scope = await sectionScope("CONSULTANTS");
  const query = new URL(request.url).searchParams;

  const company = await prisma.company.findFirstOrThrow({
    where: { id: scope.companyId },
    select: { name: true, operatingTimeZone: true },
  });

  const requestedStatus = query.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(requestedStatus)
    ? (requestedStatus as (typeof STATUSES)[number])
    : null;

  const consultantId = query.get("consultant") || null;
  const consultant = consultantId
    ? await prisma.vendor.findFirst({
        where: { id: consultantId, companyId: scope.companyId },
        select: { id: true, name: true },
      })
    : null;

  const period = resolvePeriod(
    {
      period: query.get("period") ?? undefined,
      from: query.get("from") ?? undefined,
      to: query.get("to") ?? undefined,
    },
    operatingToday(new Date(), company.operatingTimeZone),
  );

  const where: Prisma.WorkOrderWhereInput = {
    ...scope.where,
    ...(status ? { status } : {}),
    // Only a consultant that resolved in this company: an id from elsewhere
    // filters to nothing rather than being ignored and exporting everything.
    ...(consultantId ? { vendorId: consultant?.id ?? "__none__" } : {}),
    ...periodWhere(period, "issueDate"),
  };

  const workOrders = await prisma.workOrder.findMany({
    where,
    include: {
      vendor: { select: { name: true } },
      lines: { select: { id: true } },
    },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
  });

  const bytes = await buildWorkOrdersWorkbook({
    companyName: company.name,
    filterSummary: workOrderFilterSummary({
      status,
      consultantName: consultant?.name ?? null,
      from: period.from,
      to: period.to,
    }),
    rows: workOrders.map((workOrder) => ({
      number: workOrder.workOrderNumber,
      consultantName: workOrder.vendor.name,
      issueDate: workOrder.issueDate,
      dueDate: workOrder.dueDate,
      lineCount: workOrder.lines.length,
      status: workOrder.status,
      total: workOrder.total.toFixed(2),
      balanceDue: workOrder.balanceDue.toFixed(2),
      currency: workOrder.currency,
    })),
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "workOrders.exported",
    entityType: "WorkOrder",
    summary: `${workOrders.length} row${workOrders.length === 1 ? "" : "s"} — ${workOrderFilterSummary(
      {
        status,
        consultantName: consultant?.name ?? null,
        from: period.from,
        to: period.to,
      },
    )}`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${workOrdersFilename(
        company.name,
        new Date(),
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}
