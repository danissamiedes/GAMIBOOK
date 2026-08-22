import { createHash } from "node:crypto";
import type { BankAmountLayout, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  readWorkbook,
  ImportParseError,
  MAX_IMPORT_ROWS,
} from "@/lib/imports/parse";
import { parseSheetDate } from "@/lib/imports/validate";
import { money, parseMoney, type Money } from "@/lib/money";
import { isoDate } from "@/lib/dates";

/**
 * Reading a bank statement (SPEC §8.4).
 *
 * Unlike the work order import, the columns cannot be known in advance: every
 * bank names them differently, and two layouts are in common use — one signed
 * amount column, or separate debit and credit columns. So the user maps them,
 * and the mapping is saved against the bank account so the next import is one
 * click.
 *
 * Nothing here posts. A statement line is a claim about what the bank did; it
 * becomes accounting only when someone matches it (see match.ts).
 */

export type DateFormat = "MDY" | "DMY" | "ISO";

export type ColumnMapping = {
  dateColumn: string;
  descriptionColumn: string;
  amountLayout: BankAmountLayout;
  amountColumn?: string | null;
  debitColumn?: string | null;
  creditColumn?: string | null;
  referenceColumn?: string | null;
  dateFormat?: DateFormat | null;
};

export type StagedRow = {
  rowNumber: number;
  date: Date | null;
  description: string;
  amount: Money | null;
  reference: string | null;
  dedupeHash: string;
  error?: string;
};

export type StagedStatement = {
  headers: string[];
  rows: StagedRow[];
  valid: StagedRow[];
  rejected: StagedRow[];
  /** Rows already present for this bank account, by hash. */
  duplicates: StagedRow[];
  earliest: Date | null;
  latest: Date | null;
};

/**
 * The dedupe key the spec names: bank account, date, amount, description.
 *
 * Deliberately not the row's position or the file: the same transaction in an
 * overlapping statement must collide, and banks re-issue statements with
 * different row orders and file names all the time.
 */
export function dedupeHash(input: {
  date: Date;
  amount: Money;
  description: string;
}): string {
  return createHash("sha256")
    .update(
      [
        // isoDate, not the display format: this string is hashed, and every
        // previously imported row was hashed with yyyy-mm-dd. Change it and a
        // re-imported statement matches nothing and duplicates every line.
        isoDate(input.date),
        input.amount.toFixed(2),
        // Whitespace and case vary between a bank's own re-exports.
        input.description.trim().toLowerCase().replace(/\s+/g, " "),
      ].join("|"),
    )
    .digest("hex");
}

/** Suggest a mapping from the headers, so the common case needs no thought. */
export function suggestMapping(headers: string[]): Partial<ColumnMapping> {
  const find = (...patterns: RegExp[]) =>
    headers.find((header) =>
      patterns.some((pattern) => pattern.test(header.toLowerCase())),
    );

  const debit = find(/^debit$/, /withdraw/, /money out/, /paid out/, /^out$/);
  const credit = find(/^credit$/, /deposit/, /money in/, /paid in/, /^in$/);
  const amount = find(/^amount$/, /^value$/, /transaction amount/);

  return {
    dateColumn: find(/date/, /posted/),
    descriptionColumn: find(
      /description/,
      /particular/,
      /narrative/,
      /details/,
      /payee/,
      /memo/,
    ),
    // Separate columns win when both are present: a file with all three
    // usually has an amount column that repeats one of them.
    amountLayout: debit && credit ? "DEBIT_CREDIT" : "SIGNED",
    amountColumn: amount,
    debitColumn: debit,
    creditColumn: credit,
    referenceColumn: find(
      /reference/,
      /^ref$/,
      /cheque/,
      /check no/,
      /transaction id/,
    ),
  };
}

function readAmount(
  raw: Record<string, unknown>,
  mapping: ColumnMapping,
): { amount: Money | null; error?: string } {
  if (mapping.amountLayout === "SIGNED") {
    if (!mapping.amountColumn)
      return { amount: null, error: "No amount column mapped" };
    const parsed = parseMoney(String(raw[mapping.amountColumn] ?? ""));
    if (parsed === null)
      return { amount: null, error: "Amount is not a number" };
    return { amount: parsed };
  }

  const debitRaw = mapping.debitColumn
    ? String(raw[mapping.debitColumn] ?? "").trim()
    : "";
  const creditRaw = mapping.creditColumn
    ? String(raw[mapping.creditColumn] ?? "").trim()
    : "";
  const debit = debitRaw ? parseMoney(debitRaw) : null;
  const credit = creditRaw ? parseMoney(creditRaw) : null;

  if (debit === null && credit === null) {
    return { amount: null, error: "Neither debit nor credit has an amount" };
  }
  if (
    debit !== null &&
    credit !== null &&
    !debit.isZero() &&
    !credit.isZero()
  ) {
    return { amount: null, error: "Both debit and credit have an amount" };
  }

  // Debit on a statement is money leaving the account, so it is negative here.
  // Statements print it unsigned; taking it as written would flip every payment
  // into a receipt.
  const value =
    debit !== null && !debit.isZero()
      ? debit.abs().negated()
      : (credit ?? money(0));
  return { amount: value };
}

export async function stageStatement(options: {
  bankAccountId: string;
  bytes: Buffer;
  fileName: string;
  mapping: ColumnMapping;
}): Promise<StagedStatement> {
  const sheet = await readWorkbook({
    bytes: options.bytes,
    fileName: options.fileName,
  });
  if (sheet.rows.length === 0)
    throw new ImportParseError("That file has no rows.");
  if (sheet.rows.length >= MAX_IMPORT_ROWS) {
    throw new ImportParseError(
      `That file has more than ${MAX_IMPORT_ROWS} rows. Import it in parts.`,
    );
  }

  const { mapping } = options;
  const rows: StagedRow[] = sheet.rows.map((row) => {
    const description = String(row.raw[mapping.descriptionColumn] ?? "").trim();
    const date = parseSheetDate(
      row.raw[mapping.dateColumn],
      mapping.dateFormat ?? "ISO",
    );
    const { amount, error: amountError } = readAmount(row.raw, mapping);
    const reference = mapping.referenceColumn
      ? String(row.raw[mapping.referenceColumn] ?? "").trim() || null
      : null;

    const error = !date
      ? "Date could not be read — check the date format"
      : !description
        ? "No description"
        : amountError;

    return {
      rowNumber: row.rowNumber,
      date,
      description,
      amount: amount ?? null,
      reference,
      dedupeHash:
        date && amount
          ? dedupeHash({ date, amount, description })
          : `invalid-${row.rowNumber}`,
      error,
    };
  });

  const valid = rows.filter((row) => !row.error);
  const rejected = rows.filter((row) => row.error);

  // Which of these we already hold. Checked against the database rather than
  // only within the file, because the overlap that matters is with the last
  // statement, not with this one.
  const existing = await prisma.bankTransaction.findMany({
    where: {
      bankAccountId: options.bankAccountId,
      dedupeHash: { in: valid.map((row) => row.dedupeHash) },
    },
    select: { dedupeHash: true },
  });
  const known = new Set(existing.map((row) => row.dedupeHash));

  // A file that repeats a line within itself is the same problem.
  const seen = new Set<string>();
  const duplicates: StagedRow[] = [];
  const fresh: StagedRow[] = [];
  for (const row of valid) {
    if (known.has(row.dedupeHash) || seen.has(row.dedupeHash))
      duplicates.push(row);
    else {
      seen.add(row.dedupeHash);
      fresh.push(row);
    }
  }

  const dates = valid
    .map((row) => row.date!)
    .sort((a, b) => a.getTime() - b.getTime());

  return {
    headers: sheet.headers.filter(Boolean),
    rows,
    valid: fresh,
    rejected,
    duplicates,
    earliest: dates[0] ?? null,
    latest: dates[dates.length - 1] ?? null,
  };
}

/**
 * Write the staged lines. Duplicates are never written — that is the point.
 *
 * The batch is passed in rather than created here: the upload already made one
 * to hold the file while the columns were being mapped, and creating a second
 * would show every import twice in the statement history.
 */
export async function commitStatement(options: {
  companyId: string;
  bankAccountId: string;
  batchId?: string | null;
  fileName: string;
  rows: StagedRow[];
  userId?: string | null;
}) {
  const fileHash = createHash("sha256")
    .update(options.rows.map((row) => row.dedupeHash).join(""))
    .digest("hex");

  return prisma.$transaction(async (tx) => {
    const batch = options.batchId
      ? await tx.importBatch.update({
          where: { id: options.batchId },
          data: {
            status: "COMMITTED",
            fileHash,
            rowCount: options.rows.length,
            createdCount: options.rows.length,
            committedAt: new Date(),
          },
        })
      : await tx.importBatch.create({
          data: {
            companyId: options.companyId,
            kind: "BANK",
            status: "COMMITTED",
            fileName: options.fileName,
            fileHash,
            rowCount: options.rows.length,
            createdCount: options.rows.length,
            uploadedByUserId: options.userId ?? null,
            committedAt: new Date(),
          },
        });

    const data: Prisma.BankTransactionCreateManyInput[] = options.rows.map(
      (row) => ({
        companyId: options.companyId,
        bankAccountId: options.bankAccountId,
        date: row.date!,
        description: row.description,
        amount: row.amount!.toFixed(2),
        reference: row.reference,
        importBatchId: batch.id,
        dedupeHash: row.dedupeHash,
      }),
    );

    // skipDuplicates as a belt to the staging braces: two people importing the
    // same file at once would otherwise race past the check.
    const created = await tx.bankTransaction.createMany({
      data,
      skipDuplicates: true,
    });

    return { batchId: batch.id, created: created.count };
  });
}
