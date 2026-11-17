/**
 * The consultant bill sheet (SPEC §8.3):
 *
 *   DATE | NUM | CONSULTANT | DESCRIPTION | AMOUNT | ACCOUNT | DUE DATE | LINK TO FILE
 *
 * The expense sheet's columns, with the two differences a bill actually has.
 *
 * **CONSULTANT is required.** An expense can be recorded with no payee — the
 * money left the bank either way. A bill cannot: it is a debt, and the ledger
 * refuses one that does not say who is owed. So the column is required at the
 * upload rather than row by row at the commit.
 *
 * **DUE DATE is new, and optional.** A row that leaves it blank takes the
 * consultant's own payment terms, counted from the bill date, because that is
 * what was agreed with them. A sheet that tracks due dates can state them and
 * one that does not need not have the column at all.
 *
 * Definitions live here alone so the template generator and the parser cannot
 * drift apart, exactly as they do for the expense and work order imports.
 */

export type ConsultantBillColumnKey =
  | "date"
  | "num"
  | "consultant"
  | "description"
  | "amount"
  | "account"
  | "dueDate"
  | "fileLink";

export type ConsultantBillColumnDefinition = {
  key: ConsultantBillColumnKey;
  /** What the header says in the sheet. */
  header: string;
  required: boolean;
  /** Other spellings seen in the wild, matched case- and space-insensitively. */
  aliases: string[];
  note: string;
};

export const CONSULTANT_BILL_IMPORT_COLUMNS: ConsultantBillColumnDefinition[] = [
  {
    key: "date",
    header: "DATE",
    required: true,
    aliases: ["bill date", "invoice date", "transaction date", "date billed"],
    note: "The day the bill is dated. The cost posts on it.",
  },
  {
    key: "num",
    header: "NUM",
    required: true,
    aliases: ["no", "number", "ref", "reference", "invoice no", "bill no", "or no"],
    note: "The consultant's own invoice or reference number. Required, and kept as the bill's reference, leading zeros and all.",
  },
  {
    key: "consultant",
    header: "CONSULTANT",
    // Required, as the ledger requires it: a bill is a debt and has to say
    // who is owed. A sheet without this column is refused at the upload.
    required: true,
    aliases: ["name", "payee", "consultant name", "billed by", "supplier", "contractor"],
    note: "Who is owed. Matched to a consultant already on file; unfamiliar names are listed for you to approve before any are created.",
  },
  {
    key: "description",
    header: "DESCRIPTION",
    required: true,
    aliases: ["particulars", "details", "memo", "work done"],
    note: "What the bill is for.",
  },
  {
    key: "amount",
    header: "AMOUNT",
    required: true,
    aliases: ["total", "amount due", "cost", "fee"],
    note: "What is owed. Commas and currency symbols are fine; a blank or zero row is skipped.",
  },
  {
    key: "account",
    header: "ACCOUNT",
    required: true,
    aliases: ["category", "expense account", "account name", "classification"],
    note: "The sheet's own category — Consultant Fees, Labor. Mapped to a real account once, then remembered.",
  },
  {
    key: "dueDate",
    header: "DUE DATE",
    required: false,
    aliases: ["due", "payable on", "due on", "payment due"],
    note: "When it falls due. Leave blank and the consultant's own payment terms decide, counted from the bill date.",
  },
  {
    key: "fileLink",
    header: "LINK TO FILE",
    required: false,
    aliases: ["file", "invoice", "attachment", "link", "file name"],
    note: "The invoice's file name or link, kept on the bill so the paperwork can be found.",
  },
];

/** Headers compare ignoring case, spaces, dots, dashes and underscores. */
export function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s._-]+/g, " ");
}

export function consultantBillColumnFor(
  header: string,
): ConsultantBillColumnDefinition | undefined {
  const wanted = normaliseHeader(header);
  return CONSULTANT_BILL_IMPORT_COLUMNS.find(
    (column) =>
      normaliseHeader(column.header) === wanted ||
      column.aliases.some((alias) => normaliseHeader(alias) === wanted),
  );
}
