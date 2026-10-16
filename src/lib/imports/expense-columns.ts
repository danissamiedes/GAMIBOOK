/**
 * The client's real expense spreadsheet (SPEC §8.3, supplied 2026-10-16):
 *
 *   MONTH | DATE | NUM | NAME | DESCRIPTION | AMOUNT | ACCOUNT | LINK TO FILE
 *
 * MONTH is deliberately absent from this list. It is "202507- JUL", a label
 * derived from the date and used for the sheet's own pivot — importing it would
 * mean trusting two columns to agree about when something happened.
 *
 * Definitions live here alone so the template generator and the parser cannot
 * drift apart, exactly as they do for the work order import.
 */

export type ExpenseColumnKey =
  | "date"
  | "num"
  | "name"
  | "description"
  | "amount"
  | "account"
  | "fileLink";

export type ExpenseColumnDefinition = {
  key: ExpenseColumnKey;
  /** What the header says in the client's sheet. */
  header: string;
  required: boolean;
  /** Other spellings seen in the wild, matched case- and space-insensitively. */
  aliases: string[];
  note: string;
};

export const EXPENSE_IMPORT_COLUMNS: ExpenseColumnDefinition[] = [
  {
    key: "date",
    header: "DATE",
    required: true,
    aliases: ["transaction date", "date paid", "expense date"],
    note: "The day the money went out. The expense posts on it.",
  },
  {
    key: "num",
    header: "NUM",
    required: false,
    aliases: ["no", "number", "ref", "reference", "or no", "receipt no", "invoice no"],
    note: "The receipt or voucher number. Kept as the expense's reference, leading zeros and all.",
  },
  {
    key: "name",
    header: "NAME",
    required: false,
    aliases: ["payee", "vendor", "supplier", "paid to", "store"],
    note: "Who was paid. Matched to a vendor, and created as one if it is new.",
  },
  {
    key: "description",
    header: "DESCRIPTION",
    required: true,
    aliases: ["particulars", "details", "memo"],
    note: "What was bought.",
  },
  {
    key: "amount",
    header: "AMOUNT",
    required: true,
    aliases: ["total", "amount paid", "cost"],
    note: "What it cost. Commas and currency symbols are fine; a blank or zero row is skipped.",
  },
  {
    key: "account",
    header: "ACCOUNT",
    required: true,
    aliases: ["category", "expense account", "account name", "classification"],
    note: "The sheet's own category — Materials, Labor, Food. Mapped to a real account once, then remembered.",
  },
  {
    key: "fileLink",
    header: "LINK TO FILE",
    required: false,
    aliases: ["file", "receipt", "attachment", "link", "file name"],
    note: "The receipt's file name or link, kept on the expense so the paperwork can be found.",
  },
];

/** Headers compare ignoring case, spaces, dots, dashes and underscores. */
export function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, " ");
}

export function expenseColumnFor(header: string): ExpenseColumnDefinition | undefined {
  const wanted = normaliseHeader(header);
  return EXPENSE_IMPORT_COLUMNS.find(
    (column) =>
      normaliseHeader(column.header) === wanted ||
      column.aliases.some((alias) => normaliseHeader(alias) === wanted),
  );
}
