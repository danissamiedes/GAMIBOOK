import ExcelJS from "exceljs";
import { APP_NAME } from "@/lib/brand";
import { formatAccountingDate } from "@/lib/dates";
import { money } from "@/lib/money";

/**
 * One account's ledger as a spreadsheet — the account detail screen (SPEC
 * §12.4), column for column, including the opening and closing balances.
 *
 * Two things this does that a naive dump of the table would not:
 *
 * Amounts go in as numbers, not strings. A column nobody can sum is not much
 * of an export, and `Decimal.toFixed()` arrives in Excel as text that looks
 * right and totals to zero. Rounding through `money()` first keeps the value
 * the ledger holds rather than whatever a float would make of it.
 *
 * It carries a title block. This file gets emailed to an accountant, and a
 * sheet of numbers that does not say which account, which period, or whose
 * books it belongs to is a support question waiting to happen. The cost is
 * that the header row is not row 1, so everything below is offset — hence
 * HEADER_ROW rather than a scattering of magic numbers.
 */

/** The row the column headers sit on, below the title block. */
const HEADER_ROW = 5;

export type AccountLedgerRow = {
  date: Date;
  entryNumber: number;
  source: string;
  description: string;
  partyName: string | null;
  /** Decimal strings. Zero means "leave the cell empty", as the screen does. */
  debit: string;
  credit: string;
  runningBalance: string;
};

export async function buildAccountWorkbook(options: {
  companyName: string;
  baseCurrency: string;
  account: { code: string; name: string; type: string; normalBalance: string };
  from: Date | null;
  to: Date;
  opening: string;
  closing: string;
  rows: AccountLedgerRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = APP_NAME;
  workbook.created = new Date();

  // Excel refuses a sheet name over 31 characters or containing : \ / ? * [ ].
  // The full name is in the title block, so truncating here loses nothing.
  const sheetName = `${options.account.code} ${options.account.name}`
    .replace(/[:\\/?*[\]]/g, " ")
    .slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Entry", key: "entry", width: 9 },
    { header: "Source", key: "source", width: 18 },
    { header: "Description", key: "description", width: 44 },
    { header: "Party", key: "party", width: 26 },
    { header: "Debit", key: "debit", width: 15 },
    { header: "Credit", key: "credit", width: 15 },
    { header: "Balance", key: "balance", width: 16 },
  ];

  // `sheet.columns` writes the headers into row 1, which is where the title
  // block goes instead. Move them down and rewrite row 1.
  sheet.spliceRows(1, 1);
  sheet.spliceRows(1, 0, [], [], [], []);

  const period = options.from
    ? `${formatAccountingDate(options.from)} to ${formatAccountingDate(options.to)}`
    : `Up to ${formatAccountingDate(options.to)}`;

  sheet.getCell("A1").value = `${options.account.code} ${options.account.name}`;
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.getCell("A2").value =
    `${options.account.type.toLowerCase()} · ${options.account.normalBalance.toLowerCase()}-normal · ${period}`;
  sheet.getCell("A3").value = `${options.companyName} · amounts in ${options.baseCurrency}`;
  sheet.getCell("A2").font = { color: { argb: "FF64748B" } };
  sheet.getCell("A3").font = { color: { argb: "FF64748B" } };

  const header = sheet.getRow(HEADER_ROW);
  header.values = ["Date", "Entry", "Source", "Description", "Party", "Debit", "Credit", "Balance"];
  header.font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];

  const numeric = (row: ExcelJS.Row, keys: string[]) => {
    for (const key of keys) row.getCell(key).numFmt = "#,##0.00";
  };

  // Only when a start date was given — without one the report runs from the
  // beginning of the books and the opening balance is nothing, which is what
  // the screen says by omitting the row.
  if (options.from) {
    const openingRow = sheet.addRow({
      description: "Opening balance",
      balance: Number(money(options.opening).toFixed(2)),
    });
    openingRow.font = { italic: true };
    numeric(openingRow, ["balance"]);
  }

  const firstLineRow = sheet.rowCount + 1;
  for (const row of options.rows) {
    const added = sheet.addRow({
      // A real date, so Excel sorts and filters it as one rather than as text.
      date: row.date,
      entry: row.entryNumber,
      source: row.source,
      description: row.description,
      party: row.partyName ?? "",
      // Blank rather than 0 where there is no movement, matching the screen:
      // a column of zeroes hides which side each line actually hit.
      debit: money(row.debit).isZero() ? null : Number(money(row.debit).toFixed(2)),
      credit: money(row.credit).isZero() ? null : Number(money(row.credit).toFixed(2)),
      balance: Number(money(row.runningBalance).toFixed(2)),
    });
    added.getCell("date").numFmt = "mm/dd/yyyy";
    numeric(added, ["debit", "credit", "balance"]);
  }
  const lastLineRow = sheet.rowCount;

  // Live formulas rather than baked totals: the first thing anyone does with
  // this is delete a row they do not care about, and a frozen total would then
  // be quietly wrong.
  const total = sheet.addRow({
    description: "Closing balance",
    ...(options.rows.length > 0
      ? {
          debit: { formula: `SUM(F${firstLineRow}:F${lastLineRow})` },
          credit: { formula: `SUM(G${firstLineRow}:G${lastLineRow})` },
        }
      : {}),
    balance: Number(money(options.closing).toFixed(2)),
  });
  total.font = { bold: true };
  total.border = { top: { style: "thin" } };
  numeric(total, ["debit", "credit", "balance"]);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** `5000-Consultant-Fees-Bookkeeping-Point-2026-08-23.xlsx` */
export function accountFilename(
  account: { code: string; name: string },
  companyName: string,
  on: Date,
): string {
  const slug = (value: string, max: number) =>
    value
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max);
  // A slash is not legal in a filename, so the date stays yyyy-mm-dd here
  // whatever the app shows a person.
  return `${slug(`${account.code} ${account.name}`, 48)}-${slug(companyName, 40)}-${on
    .toISOString()
    .slice(0, 10)}.xlsx`;
}
