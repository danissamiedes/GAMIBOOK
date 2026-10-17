import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import {
  buildPurchaseOrdersWorkbook,
  purchaseOrderFilterSummary,
  purchaseOrdersFilename,
} from "@/lib/exports/purchase-orders-workbook";

const STATUSES = ["DRAFT", "ISSUED", "RECEIVED", "CANCELLED"] as const;

/**
 * The purchase orders list, as a spreadsheet.
 *
 * Scoped exactly like the screen it comes from — the VENDORS section — and it
 * reads the same status and vendor params, so the file is what is on screen.
 * Deliberately not paginated: a spreadsheet exists so somebody can have the
 * lot, and a silently truncated export is worse than a slow one.
 */
export async function GET(request: Request) {
  const scope = await sectionScope("VENDORS");
  const query = new URL(request.url).searchParams;

  const requested = query.get("status") ?? "";
  const status = (STATUSES as readonly string[]).includes(requested)
    ? (requested as (typeof STATUSES)[number])
    : null;
  const vendorId = query.get("vendor");

  const [company, vendor, orders] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { name: true },
    }),
    vendorId && vendorId !== "ALL"
      ? prisma.vendor.findFirst({
          where: { id: vendorId, ...scope.where },
          select: { name: true },
        })
      : Promise.resolve(null),
    prisma.purchaseOrder.findMany({
      where: {
        ...scope.where,
        ...(status ? { status } : {}),
        ...(vendorId && vendorId !== "ALL" ? { vendorId } : {}),
      },
      include: {
        vendor: { select: { name: true } },
        expense: { select: { reference: true } },
        _count: { select: { lines: true } },
      },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const bytes = await buildPurchaseOrdersWorkbook({
    companyName: company.name,
    filterSummary: purchaseOrderFilterSummary({ status, vendorName: vendor?.name ?? null }),
    rows: orders.map((order) => ({
      number: order.orderNumber,
      vendorName: order.vendor.name,
      orderDate: order.orderDate,
      expectedDate: order.expectedDate,
      lineCount: order._count.lines,
      status: order.status,
      total: order.total.toFixed(2),
      currency: order.currency,
      lastEmailedAt: order.lastEmailedAt,
      billReference: order.expense?.reference ?? null,
    })),
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "purchase_orders.exported",
    entityType: "PurchaseOrder",
    summary: `${orders.length} row${orders.length === 1 ? "" : "s"}`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${purchaseOrdersFilename(
        company.name,
        new Date(),
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}
