import ExcelJS from "exceljs";
import { APP_NAME } from "@/lib/brand";
import { money } from "@/lib/money";
import { safeExternalUrl } from "@/lib/links";

/**
 * The expenses or bills list as a spreadsheet, matching the columns on screen.
 *
 * Amounts go in as numbers, not strings: a column somebody cannot sum is not
 * much of an export, and Decimal.toFixed() would arrive in Excel as text.
 * Rounding through `money()` first keeps the value the ledger holds rather
 * than whatever a float would make of it.
 */

export type ExpenseRow = {
  date: Date;
  reference: string | null;
  vendorName: string | null;
  description: string;
  amount: string;
  balanceDue: string;
  currency: string;
  receiptUrl: string | null;
};

export async function buildExpensesWorkbook(options: {
  kind: "DIRECT" | "BILL";
  companyName: string;
  rows: ExpenseRow[];
}): Promise<Buffer> {
  const isBill = options.kind === "BILL";
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(isBill ? "Bills" : "Direct expenses");
  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Reference", key: "reference", width: 18 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Description", key: "description", width: 44 },
    { header: "Amount", key: "amount", width: 14 },
    ...(isBill ? [{ header: "Balance", key: "balance", width: 14 }] : []),
    { header: "Currency", key: "currency", width: 10 },
    { header: "File link", key: "fileLink", width: 46 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of options.rows) {
    const added = sheet.addRow({
      // A real date, so Excel can sort and filter it as one.
      date: row.date,
      reference: row.reference ?? "",
      vendor: row.vendorName ?? "",
      description: row.description,
      amount: Number(money(row.amount).toFixed(2)),
      ...(isBill ? { balance: Number(money(row.balanceDue).toFixed(2)) } : {}),
      currency: row.currency,
      fileLink: row.receiptUrl ?? "",
    });

    added.getCell("date").numFmt = "yyyy-mm-dd";
    added.getCell("amount").numFmt = "#,##0.00";
    if (isBill) added.getCell("balance").numFmt = "#,##0.00";

    // Only a link the app would itself render as one: the same check the
    // screen applies, so a spreadsheet cannot become the way a bad URL gets
    // clicked.
    const safe = safeExternalUrl(row.receiptUrl);
    if (safe) {
      const cell = added.getCell("fileLink");
      cell.value = { text: safe, hyperlink: safe };
      cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
    }
  }

  // A total, because the first thing anybody does with this is add it up.
  if (options.rows.length > 0) {
    const total = sheet.addRow({
      description: "Total",
      amount: { formula: `SUM(E2:E${options.rows.length + 1})` },
      ...(isBill ? { balance: { formula: `SUM(F2:F${options.rows.length + 1})` } } : {}),
    });
    total.font = { bold: true };
    total.getCell("amount").numFmt = "#,##0.00";
    if (isBill) total.getCell("balance").numFmt = "#,##0.00";
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** `Direct-expenses-Bookkeeping-Point-2026-08-22.xlsx` */
export function expensesFilename(kind: "DIRECT" | "BILL", companyName: string, on: Date): string {
  const slug = companyName.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const label = kind === "BILL" ? "Bills" : "Direct-expenses";
  return `${label}-${slug}-${on.toISOString().slice(0, 10)}.xlsx`;
}
