import { APP_NAME } from "@/lib/brand";
import { formatAccountingDate } from "@/lib/dates";
import { money } from "@/lib/money";
import type { PartyTotals, PartyTransaction } from "@/lib/parties/transactions";

/**
 * A party's transactions as a spreadsheet — the tab, column for column.
 *
 * Amounts go in as numbers, not strings: a column nobody can sum is not much
 * of an export, and `Decimal.toFixed()` arrives in Excel as text that looks
 * right and adds up to nothing.
 *
 * Two amount columns, always. A bill in USD belongs in the file as 100 USD,
 * and the base-currency column beside it is the only one the totals row is
 * allowed to add up — the same rule the screen follows, for the same reason.
 *
 * The title block says whose account, which period and whose books, because
 * this file gets emailed to an accountant, and one that does not say is a
 * question coming back.
 */

/** The row the column headers sit on, below the title block. */
const HEADER_ROW = 6;

export async function buildPartyTransactionsWorkbook(options: {
  companyName: string;
  baseCurrency: string;
  party: { name: string; kind: "Vendor" | "Consultant" };
  from: Date | null;
  to: Date | null;
  rows: PartyTransaction[];
  totals: PartyTotals;
}): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();

  // Excel refuses a sheet name over 31 characters or containing : \ / ? * [ ].
  const sheet = workbook.addWorksheet(
    options.party.name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31) || "Transactions",
  );

  sheet.columns = [
    { header: "", key: "date", width: 12 },
    { header: "", key: "type", width: 16 },
    { header: "", key: "reference", width: 18 },
    { header: "", key: "description", width: 44 },
    { header: "", key: "amount", width: 15 },
    { header: "", key: "currency", width: 10 },
    { header: "", key: "base", width: 16 },
    { header: "", key: "owed", width: 15 },
    { header: "", key: "status", width: 12 },
  ];

  const period =
    options.from || options.to
      ? `${options.from ? formatAccountingDate(options.from) : "the beginning"} to ${
          options.to ? formatAccountingDate(options.to) : "today"
        }`
      : "All dates";

  sheet.getCell("A1").value = options.party.name;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value = `${options.party.kind} · ${options.companyName}`;
  sheet.getCell("A3").value = period;
  sheet.getCell("A4").value =
    `Billed ${options.totals.spend.toFixed(2)} · ` +
    `Paid ${options.totals.paid.toFixed(2)} · ` +
    `Still owed ${options.totals.outstanding.toFixed(2)} (${options.baseCurrency})`;

  const header = sheet.getRow(HEADER_ROW);
  header.values = [
    "Date",
    "Type",
    "Reference",
    "Description",
    "Amount",
    "Currency",
    `Amount (${options.baseCurrency})`,
    `Still owed (${options.baseCurrency})`,
    "Status",
  ];
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];

  for (const row of options.rows) {
    const added = sheet.addRow({
      // A real date, so Excel can sort and filter it as one.
      date: row.date,
      type: row.label,
      reference: row.reference ?? "",
      description: row.description,
      // A payment is money going the other way, and reads that way here too.
      amount: Number(money(row.amount).toFixed(2)) * (row.kind === "PAYMENT" ? -1 : 1),
      currency: row.currency,
      base: Number(money(row.baseAmount).toFixed(2)) * (row.kind === "PAYMENT" ? -1 : 1),
      owed: row.outstanding ? Number(money(row.outstanding).toFixed(2)) : null,
      status: row.status,
    });

    added.getCell("date").numFmt = "mm/dd/yyyy";
    added.getCell("amount").numFmt = "#,##0.00;-#,##0.00";
    added.getCell("base").numFmt = "#,##0.00;-#,##0.00";
    added.getCell("owed").numFmt = "#,##0.00";
  }

  if (options.rows.length > 0) {
    const first = HEADER_ROW + 1;
    const last = HEADER_ROW + options.rows.length;
    const total = sheet.addRow({
      description: `Total (${options.baseCurrency})`,
      // Only the base-currency columns: adding PHP to USD is the one thing a
      // total must never quietly do.
      base: { formula: `SUM(G${first}:G${last})` },
      owed: { formula: `SUM(H${first}:H${last})` },
    });
    total.font = { bold: true };
    total.getCell("base").numFmt = "#,##0.00;-#,##0.00";
    total.getCell("owed").numFmt = "#,##0.00";
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** `Transactions-DAVAO-LIGHT-2026-10-17.xlsx` */
export function partyTransactionsFilename(partyName: string, on: Date): string {
  const slug = partyName
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `Transactions-${slug}-${on.toISOString().slice(0, 10)}.xlsx`;
}
