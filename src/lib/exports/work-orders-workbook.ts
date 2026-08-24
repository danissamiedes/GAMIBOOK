import ExcelJS from "exceljs";
import { APP_NAME } from "@/lib/brand";
import { formatAccountingDate } from "@/lib/dates";
import { money } from "@/lib/money";

/**
 * The work orders list as a spreadsheet, matching the columns on screen.
 *
 * Amounts go in as numbers, not strings: a column nobody can sum is not much
 * of an export, and `Decimal.toFixed()` arrives in Excel as text that looks
 * right and totals to zero. Rounding through `money()` first keeps the value
 * the ledger holds rather than whatever a float would make of it.
 *
 * A title block says which filters produced the file. Someone exporting the
 * approved work orders for August and someone exporting everything end up with
 * two files that look identical at a glance, and only one of them is the one
 * they meant to send.
 */

/** The row the column headers sit on, below the title block. */
const HEADER_ROW = 4;

export type WorkOrderRow = {
  number: string | null;
  consultantName: string;
  issueDate: Date;
  dueDate: Date;
  lineCount: number;
  status: string;
  total: string;
  balanceDue: string;
  currency: string;
};

export async function buildWorkOrdersWorkbook(options: {
  companyName: string;
  /** What was filtered, already worded — "approved · 08/01/2026 to 08/31/2026". */
  filterSummary: string;
  rows: WorkOrderRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Work orders");
  sheet.columns = [
    { header: "Number", key: "number", width: 12 },
    { header: "Consultant", key: "consultant", width: 28 },
    { header: "Date", key: "date", width: 12 },
    { header: "Due", key: "due", width: 12 },
    { header: "Lines", key: "lines", width: 8 },
    { header: "Status", key: "status", width: 16 },
    { header: "Total", key: "total", width: 16 },
    { header: "Balance", key: "balance", width: 16 },
    { header: "Currency", key: "currency", width: 10 },
  ];

  // `sheet.columns` writes the headers into row 1, which is where the title
  // block goes instead. Move them down and rewrite row 1.
  sheet.spliceRows(1, 1);
  sheet.spliceRows(1, 0, [], [], []);

  sheet.getCell("A1").value = "Work orders";
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = `${options.companyName} · ${options.filterSummary}`;
  sheet.getCell("A2").font = { color: { argb: "FF64748B" } };

  const header = sheet.getRow(HEADER_ROW);
  header.values = [
    "Number",
    "Consultant",
    "Date",
    "Due",
    "Lines",
    "Status",
    "Total",
    "Balance",
    "Currency",
  ];
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];

  const firstLineRow = HEADER_ROW + 1;
  for (const row of options.rows) {
    const added = sheet.addRow({
      // A draft has no number yet, and the screen says so rather than blank.
      number: row.number ?? "draft",
      consultant: row.consultantName,
      // Real dates, so Excel sorts and filters them as dates rather than text.
      date: row.issueDate,
      due: row.dueDate,
      lines: row.lineCount,
      status: row.status.replace("_", " ").toLowerCase(),
      total: Number(money(row.total).toFixed(2)),
      balance: Number(money(row.balanceDue).toFixed(2)),
      currency: row.currency,
    });

    added.getCell("date").numFmt = "mm/dd/yyyy";
    added.getCell("due").numFmt = "mm/dd/yyyy";
    added.getCell("total").numFmt = "#,##0.00";
    added.getCell("balance").numFmt = "#,##0.00";
  }
  const lastLineRow = sheet.rowCount;

  // Live formulas rather than baked figures: the first thing anyone does with
  // this is delete a row they do not care about, and a frozen total would then
  // be quietly wrong.
  if (options.rows.length > 0) {
    const total = sheet.addRow({
      consultant: "Total",
      total: { formula: `SUM(G${firstLineRow}:G${lastLineRow})` },
      balance: { formula: `SUM(H${firstLineRow}:H${lastLineRow})` },
    });
    total.font = { bold: true };
    total.border = { top: { style: "thin" } };
    total.getCell("total").numFmt = "#,##0.00";
    total.getCell("balance").numFmt = "#,##0.00";

    // Only meaningful in one currency. A mixed list still gets its rows and
    // its per-row figures; what it does not get is a total implying they add.
    const currencies = new Set(options.rows.map((row) => row.currency));
    if (currencies.size > 1) {
      const note = sheet.addRow({
        consultant: `Mixed currencies (${[...currencies].sort().join(", ")}) — the total above adds unlike amounts.`,
      });
      note.font = { italic: true, color: { argb: "FFB45309" } };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** "approved · Jocel Malo · 08/01/2026 to 08/31/2026", or "all work orders". */
export function workOrderFilterSummary(filters: {
  status?: string | null;
  consultantName?: string | null;
  from?: Date | null;
  to?: Date | null;
}): string {
  const parts: string[] = [];
  if (filters.status && filters.status !== "ALL") {
    parts.push(filters.status.replace("_", " ").toLowerCase());
  }
  if (filters.consultantName) parts.push(filters.consultantName);
  if (filters.from && filters.to) {
    parts.push(`${formatAccountingDate(filters.from)} to ${formatAccountingDate(filters.to)}`);
  } else if (filters.from) {
    parts.push(`from ${formatAccountingDate(filters.from)}`);
  } else if (filters.to) {
    parts.push(`up to ${formatAccountingDate(filters.to)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "all work orders";
}

/** `Work-orders-Bookkeeping-Point-2026-08-23.xlsx` */
export function workOrdersFilename(companyName: string, on: Date): string {
  const slug = companyName
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  // A slash is not legal in a filename, so the date stays yyyy-mm-dd here
  // whatever the app shows a person.
  return `Work-orders-${slug}-${on.toISOString().slice(0, 10)}.xlsx`;
}
