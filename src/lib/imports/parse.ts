import ExcelJS from "exceljs";
import { mapHeaders, type ColumnKey } from "./columns";

/**
 * Reading the upload (SPEC §8.3). Server-side only — the browser is never
 * trusted to parse a file and post back what it found.
 */

/**
 * How large an upload may be.
 *
 * A serverless host rejects the request body before any of this code runs —
 * Vercel's cap is 4.5 MB — so a 10 MB limit there would be a promise the app
 * cannot keep: the user picks an 8 MB statement, waits, and gets an opaque
 * platform error instead of ours. Match the platform so the number in the hint
 * is the number that actually applies.
 */
export function maxImportBytes(): number {
  const serverless =
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.SERVERLESS === "true";
  return serverless ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
}

/** For messages and hints: "4 MB" or "10 MB". */
export function maxImportLabel(): string {
  return `${Math.floor(maxImportBytes() / (1024 * 1024))} MB`;
}

export const MAX_IMPORT_ROWS = 5_000;

export type RawRow = {
  rowNumber: number;
  /** The cell values, by column key, exactly as the sheet gave them. */
  values: Partial<Record<ColumnKey, unknown>>;
  /** Everything, keyed by header, for the audit record. */
  raw: Record<string, unknown>;
};

/** A sheet read without any opinion about what its columns mean. */
export type RawSheet = {
  sheetName: string;
  sheetNames: string[];
  /** Positional: a saved mapping refers to a column by index. */
  headers: string[];
  rows: { rowNumber: number; raw: Record<string, unknown> }[];
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
    if ("result" in value)
      return (value as { result?: unknown }).result ?? null;
    if ("richText" in value) {
      return (value as { richText: { text: string }[] }).richText
        .map((part) => part.text)
        .join("");
    }
    if ("text" in value) return (value as { text: string }).text;
  }
  return value;
}

/**
 * Read a spreadsheet or CSV into headers and rows keyed by header, with no
 * view on what those headers mean. The work order import knows its columns in
 * advance; a bank import cannot, because every bank names them differently and
 * the user maps them by hand (SPEC §8.4).
 */
export async function readWorkbook(options: {
  bytes: Buffer;
  fileName: string;
  sheetName?: string | null;
}): Promise<RawSheet> {
  if (options.bytes.length > maxImportBytes()) {
    throw new ImportParseError(
      `That file is over ${maxImportLabel()}. Split it and import in parts.`,
    );
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
  if (sheetNames.length === 0)
    throw new ImportParseError("That workbook has no sheets.");

  const worksheet = options.sheetName
    ? workbook.worksheets.find((sheet) => sheet.name === options.sheetName)
    : workbook.worksheets[0];
  if (!worksheet)
    throw new ImportParseError(`No sheet named "${options.sheetName}".`);

  // The header row is the first row with any content — a sheet often opens
  // with a blank line or a title.
  let headerRowNumber = 0;
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (headerRowNumber !== 0) return;
    const hasText =
      row.values &&
      Object.values(row.values).some(
        (value) => typeof value === "string" && value.trim(),
      );
    if (hasText) headerRowNumber = rowNumber;
  });
  if (headerRowNumber === 0)
    throw new ImportParseError("That sheet appears to be empty.");

  const headerRow = worksheet.getRow(headerRowNumber);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const value = cellValue(cell);
    headers[colNumber - 1] = value === null ? "" : String(value).trim();
  });

  const rows: RawSheet["rows"] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    if (rows.length >= MAX_IMPORT_ROWS) return;

    const raw: Record<string, unknown> = {};
    let hasAnything = false;

    headers.forEach((header, index) => {
      const value = cellValue(row.getCell(index + 1));
      if (value !== null && String(value).trim() !== "") hasAnything = true;
      raw[header || `Column ${index + 1}`] =
        value instanceof Date ? value.toISOString() : value;
    });

    // A blank row is skipped, not reported: spreadsheets are full of them.
    if (!hasAnything) return;
    rows.push({ rowNumber, raw });
  });

  return {
    sheetName: worksheet.name,
    sheetNames,
    headers,
    rows,
  };
}

/** The work order import (SPEC §8.3): a read, plus this app's own column map. */
export async function parseWorkbook(options: {
  bytes: Buffer;
  fileName: string;
  sheetName?: string | null;
}): Promise<ParsedSheet> {
  const sheet = await readWorkbook(options);
  const { mapping, unmatched, missingRequired } = mapHeaders(sheet.headers);

  const rows: RawRow[] = sheet.rows.map((row) => {
    const values: Partial<Record<ColumnKey, unknown>> = {};
    for (const [key, index] of Object.entries(mapping) as [
      ColumnKey,
      number,
    ][]) {
      const header = sheet.headers[index];
      values[key] = header ? (row.raw[header] ?? null) : null;
    }
    return { rowNumber: row.rowNumber, values, raw: row.raw };
  });

  return {
    sheetName: sheet.sheetName,
    sheetNames: sheet.sheetNames,
    headers: sheet.headers.filter(Boolean),
    unmatchedHeaders: unmatched,
    missingRequired,
    rows,
  };
}
