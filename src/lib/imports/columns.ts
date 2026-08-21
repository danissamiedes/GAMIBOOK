/**
 * The user's real work order spreadsheet (SPEC §8.3, supplied 2026-08-21):
 *
 *   Work Order Date | Consultant Name | Line No. | Description | Account |
 *   Quantity | Rate | Amount
 *
 * Definitions live here alone, so the template generator and the parser can
 * never drift apart, and a column added to the sheet is a change to this list
 * rather than a rewrite.
 */

export type ColumnKey =
  | "workOrderDate"
  | "consultantName"
  | "lineNo"
  | "description"
  | "account"
  | "quantity"
  | "rate"
  | "amount";

export type ColumnDefinition = {
  key: ColumnKey;
  /** What the header says in the user's sheet. */
  header: string;
  required: boolean;
  /** Other spellings seen in the wild, matched case- and space-insensitively. */
  aliases: string[];
  note: string;
};

export const WORK_ORDER_IMPORT_COLUMNS: ColumnDefinition[] = [
  {
    key: "workOrderDate",
    header: "Work Order Date",
    required: true,
    aliases: ["date", "wo date", "workorder date"],
    note: "The work order's date. The A/P entry posts on it when approved.",
  },
  {
    key: "consultantName",
    header: "Consultant Name",
    required: true,
    aliases: ["consultant", "name", "payee"],
    note: "Matched against active consultants, then their saved spreadsheet aliases.",
  },
  {
    key: "lineNo",
    header: "Line No.",
    required: true,
    aliases: ["line no", "line", "line number", "no"],
    note: "1 starts a new work order; 2, 3 … continue that consultant's current one.",
  },
  {
    key: "description",
    header: "Description",
    required: true,
    aliases: ["particulars", "details"],
    note: "The work order line description.",
  },
  {
    key: "account",
    header: "Account",
    required: true,
    aliases: ["account name", "gl account", "expense account"],
    note: "Account name or code from this company's chart of accounts.",
  },
  {
    key: "quantity",
    header: "Quantity",
    required: true,
    aliases: ["qty", "hours", "units"],
    note: "Fractional quantities are normal (0.5 of a period).",
  },
  {
    key: "rate",
    header: "Rate",
    required: true,
    aliases: ["unit rate", "price"],
    note: "May be negative — (3,000.00) is a deduction such as a cash advance.",
  },
  {
    key: "amount",
    header: "Amount",
    required: false,
    aliases: ["total", "line total"],
    note: "Optional. Checked against quantity × rate rather than trusted.",
  },
];

const normalise = (value: string) => value.trim().toLowerCase().replace(/[\s._-]+/g, " ");

/** Map the sheet's header row onto our column keys. */
export function mapHeaders(headers: (string | null)[]): {
  mapping: Partial<Record<ColumnKey, number>>;
  unmatched: string[];
  missingRequired: ColumnKey[];
} {
  const mapping: Partial<Record<ColumnKey, number>> = {};
  const unmatched: string[] = [];

  headers.forEach((header, index) => {
    if (!header) return;
    const key = normalise(header);
    const definition = WORK_ORDER_IMPORT_COLUMNS.find(
      (candidate) =>
        normalise(candidate.header) === key || candidate.aliases.some((alias) => normalise(alias) === key),
    );
    if (definition && mapping[definition.key] === undefined) mapping[definition.key] = index;
    else if (!definition) unmatched.push(header);
  });

  const missingRequired = WORK_ORDER_IMPORT_COLUMNS.filter(
    (column) => column.required && mapping[column.key] === undefined,
  ).map((column) => column.key);

  return { mapping, unmatched, missingRequired };
}

export const COLUMN_LABEL: Record<ColumnKey, string> = Object.fromEntries(
  WORK_ORDER_IMPORT_COLUMNS.map((column) => [column.key, column.header]),
) as Record<ColumnKey, string>;
