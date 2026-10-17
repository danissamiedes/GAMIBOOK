import { APP_NAME } from "@/lib/brand";
import { money } from "@/lib/money";

/**
 * The purchase orders list as a spreadsheet, matching the columns on screen.
 *
 * Amounts go in as numbers, not strings: a column nobody can sum is not much
 * of an export, and `Decimal.toFixed()` arrives in Excel as text that looks
 * right and totals to zero.
 *
 * No balance column, unlike the work orders file: nothing is owed on an
 * order. What it has instead is whether it has been sent and what it became,
 * which is what somebody chasing a delivery is actually looking for.
 */

/** The row the column headers sit on, below the title block. */
const HEADER_ROW = 4;

export type PurchaseOrderRow = {
  number: string | null;
  vendorName: string;
  orderDate: Date;
  expectedDate: Date | null;
  lineCount: number;
  status: string;
  total: string;
  currency: string;
  lastEmailedAt: Date | null;
  billReference: string | null;
};

export async function buildPurchaseOrdersWorkbook(options: {
  companyName: string;
  /** What was filtered, already worded — "issued · DAVAO LIGHT". */
  filterSummary: string;
  rows: PurchaseOrderRow[];
}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Purchase orders");
  sheet.columns = [
    { header: "Number", key: "number", width: 12 },
    { header: "Vendor", key: "vendor", width: 28 },
    { header: "Ordered", key: "date", width: 12 },
    { header: "Wanted by", key: "wanted", width: 12 },
    { header: "Lines", key: "lines", width: 8 },
    { header: "Status", key: "status", width: 14 },
    { header: "Total", key: "total", width: 16 },
    { header: "Currency", key: "currency", width: 10 },
    { header: "Emailed", key: "emailed", width: 12 },
    { header: "Became bill", key: "bill", width: 18 },
  ];

  // `sheet.columns` writes the headers into row 1, which is where the title
  // block goes instead. Move them down and rewrite row 1.
  sheet.spliceRows(1, 1);
  sheet.spliceRows(1, 0, [], [], []);

  sheet.getCell("A1").value = "Purchase orders";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = `${options.companyName} · ${options.filterSummary}`;
  sheet.getCell("A2").font = { color: { argb: "FF64748B" } };

  const header = sheet.getRow(HEADER_ROW);
  header.values = [
    "Number",
    "Vendor",
    "Ordered",
    "Wanted by",
    "Lines",
    "Status",
    "Total",
    "Currency",
    "Emailed",
    "Became bill",
  ];
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];

  const firstLineRow = HEADER_ROW + 1;
  for (const row of options.rows) {
    const added = sheet.addRow({
      // A draft has no number yet, and the screen says so rather than blank.
      number: row.number ?? "draft",
      vendor: row.vendorName,
      // Real dates, so Excel sorts and filters them as dates rather than text.
      date: row.orderDate,
      wanted: row.expectedDate,
      lines: row.lineCount,
      status: row.status.toLowerCase(),
      total: Number(money(row.total).toFixed(2)),
      currency: row.currency,
      emailed: row.lastEmailedAt,
      bill: row.billReference ?? "",
    });

    added.getCell("date").numFmt = "mm/dd/yyyy";
    added.getCell("wanted").numFmt = "mm/dd/yyyy";
    added.getCell("emailed").numFmt = "mm/dd/yyyy";
    added.getCell("total").numFmt = "#,##0.00";
  }
  const lastLineRow = sheet.rowCount;

  // A live formula rather than a baked figure: the first thing anyone does
  // with this is delete a row they do not care about.
  if (options.rows.length > 0) {
    const total = sheet.addRow({
      vendor: "Total ordered",
      total: { formula: `SUM(G${firstLineRow}:G${lastLineRow})` },
    });
    total.font = { bold: true };
    total.border = { top: { style: "thin" } };
    total.getCell("total").numFmt = "#,##0.00";

    const currencies = new Set(options.rows.map((row) => row.currency));
    if (currencies.size > 1) {
      const note = sheet.addRow({
        vendor: `Mixed currencies (${[...currencies].sort().join(", ")}) — the total above adds unlike amounts.`,
      });
      note.font = { italic: true, color: { argb: "FFB45309" } };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** "issued · DAVAO LIGHT", or "all purchase orders". */
export function purchaseOrderFilterSummary(filters: {
  status?: string | null;
  vendorName?: string | null;
}): string {
  const parts: string[] = [];
  if (filters.status && filters.status !== "ALL") parts.push(filters.status.toLowerCase());
  if (filters.vendorName) parts.push(filters.vendorName);
  return parts.length > 0 ? parts.join(" · ") : "all purchase orders";
}

/** `Purchase-orders-Bookkeeping-Point-2026-11-04.xlsx` */
export function purchaseOrdersFilename(companyName: string, on: Date): string {
  const slug = companyName
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `Purchase-orders-${slug}-${on.toISOString().slice(0, 10)}.xlsx`;
}
