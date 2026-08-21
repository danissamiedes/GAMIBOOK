import ExcelJS from "exceljs";
import { mapHeaders, type ColumnKey } from "./columns";

/**
 * Reading the upload (SPEC §8.3). Server-side only — the browser is never
 * trusted to parse a file and post back what it found.
 */

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5_000;

export type RawRow = {
  rowNumber: number;
  /** The cell values, by column key, exactly as the sheet gave them. */
  values: Partial<Record<ColumnKey, unknown>>;
  /** Everything, keyed by header, for the audit record. */
  raw: Record<string, unknown>;
};

export type ParsedSheet = {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  unmatchedHeaders: string[];
  missingRequired: ColumnKey[];
  rows: RawRow[];
};

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

function cellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    // Formulas, rich text and hyperlinks all carry their display value.
    if ("result" in value) return (value as { result?: unknown }).result ?? null;
    if ("richText" in value) {
      return (value as { richText: { text: string }[] }).richText.map((part) => part.text).join("");
    }
    if ("text" in value) return (value as { text: string }).text;
  }
  return value;
}

export async function parseWorkbook(options: {
  bytes: Buffer;
  fileName: string;
  sheetName?: string | null;
}): Promise<ParsedSheet> {
  if (options.bytes.length > MAX_IMPORT_BYTES) {
    throw new ImportParseError("That file is over 10 MB. Split it and import in parts.");
  }

  const workbook = new ExcelJS.Workbook();
  const isCsv = options.fileName.toLowerCase().endsWith(".csv");

  if (options.fileName.toLowerCase().endsWith(".xls")) {
    throw new ImportParseError(
      "That is the old .xls format. Open it in Excel and save as .xlsx, then try again.",
    );
  }

  try {
    if (isCsv) {
      const { Readable } = await import("node:stream");
      await workbook.csv.read(Readable.from(options.bytes.toString("utf8")));
    } else {
      await workbook.xlsx.load(options.bytes as unknown as ArrayBuffer);
    }
  } catch {
    throw new ImportParseError("That file could not be read as a spreadsheet.");
  }

  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  if (sheetNames.length === 0) throw new ImportParseError("That workbook has no sheets.");

  const worksheet = options.sheetName
    ? workbook.worksheets.find((sheet) => sheet.name === options.sheetName)
    : workbook.worksheets[0];
  if (!worksheet) throw new ImportParseError(`No sheet named "${options.sheetName}".`);

  // The header row is the first row with any content — a sheet often opens
  // with a blank line or a title.
  let headerRowNumber = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRowNumber !== 0) return;
    const hasText = row.values && Object.values(row.values).some((value) => typeof value === "string" && value.trim());
    if (hasText) headerRowNumber = rowNumber;
  });
  if (headerRowNumber === 0) throw new ImportParseError("That sheet appears to be empty.");

  const headerRow = worksheet.getRow(headerRowNumber);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const value = cellValue(cell);
    headers[colNumber - 1] = value === null ? "" : String(value).trim();
  });

  const { mapping, unmatched, missingRequired } = mapHeaders(headers);

  const rows: RawRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    if (rows.length >= MAX_IMPORT_ROWS) return;

    const raw: Record<string, unknown> = {};
    const values: Partial<Record<ColumnKey, unknown>> = {};
    let hasAnything = false;

    headers.forEach((header, index) => {
      const value = cellValue(row.getCell(index + 1));
      if (value !== null && String(value).trim() !== "") hasAnything = true;
      raw[header || `Column ${index + 1}`] = value instanceof Date ? value.toISOString() : value;
    });

    // A blank row is skipped, not reported: spreadsheets are full of them.
    if (!hasAnything) return;

    for (const [key, index] of Object.entries(mapping) as [ColumnKey, number][]) {
      values[key] = cellValue(row.getCell(index + 1));
    }

    rows.push({ rowNumber, values, raw });
  });

  return {
    sheetName: worksheet.name,
    sheetNames,
    headers: headers.filter(Boolean),
    unmatchedHeaders: unmatched,
    missingRequired,
    rows,
  };
}
