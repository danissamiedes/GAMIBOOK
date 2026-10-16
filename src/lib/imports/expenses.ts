import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { storage, storageKeys } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import { PostingError } from "@/lib/errors";
import { money, type Money } from "@/lib/money";
import { recordExpense } from "@/lib/payables/expenses";
import {
  EXPENSE_IMPORT_COLUMNS,
  expenseColumnFor,
  normaliseHeader,
  type ExpenseColumnKey,
} from "./expense-columns";
import { readWorkbook } from "./parse";
import { parseSheetDate } from "./validate";

/**
 * Importing a month of expenses from the client's own spreadsheet (SPEC §8.3).
 *
 * Two things make this different from the work order import, and both come
 * from what the sheet actually is: a project ledger kept by the people doing
 * the work, not an accounting document.
 *
 * **Its ACCOUNT column is the client's vocabulary**, not this company's chart —
 * "Materials", "Labor", "Food". The mapping to real accounts is chosen once in
 * the preview and kept on the account as an alias, so the next upload of next
 * month's sheet maps itself.
 *
 * **Committing posts.** A work order imports as a draft and approval posts it;
 * an expense has no draft state, so every committed row is a journal entry.
 * The preview is therefore the whole safeguard, and the commit runs in chunks
 * that can be continued — five hundred postings do not fit in one request on a
 * serverless host, and a half-finished import that cannot be resumed is worse
 * than a slow one.
 */

export function hashFile(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type ExpenseIssue = {
  column: ExpenseColumnKey | "row";
  message: string;
  severity: "error" | "warning";
  /**
   * Set on the one problem the preview exists to solve. A category nobody has
   * mapped yet is an unanswered question, not a broken row: counting it as
   * damage would tell somebody their file was unusable at the exact moment
   * they were about to make it usable.
   */
  code?: "unmappedAccount";
};

/** One row of the sheet, understood as far as it can be. */
export type ExpenseRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  values: Partial<Record<ExpenseColumnKey, unknown>>;
  issues: ExpenseIssue[];
  planned: {
    date: Date;
    amount: Money;
    description: string;
    reference: string | null;
    receiptUrl: string | null;
    /** What the sheet called it, before mapping. */
    category: string;
    accountId: string | null;
    accountLabel: string | null;
    vendorName: string | null;
    vendorId: string | null;
    /** True when committing would have to create the vendor. */
    vendorIsNew: boolean;
  } | null;
};

export type ExpenseSheet = {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  unmatchedHeaders: string[];
  missingRequired: ExpenseColumnKey[];
  rows: { rowNumber: number; raw: Record<string, unknown>; values: Partial<Record<ExpenseColumnKey, unknown>> }[];
};

/** Read the workbook and label its columns, with no opinion about contents. */
export async function readExpenseSheet(options: {
  bytes: Buffer;
  fileName: string;
  sheetName?: string | null;
}): Promise<ExpenseSheet> {
  const sheet = await readWorkbook(options);

  const mapping = new Map<ExpenseColumnKey, string>();
  const unmatched: string[] = [];
  for (const header of sheet.headers) {
    if (!header) continue;
    const column = expenseColumnFor(header);
    if (column && !mapping.has(column.key)) mapping.set(column.key, header);
    else if (!column) unmatched.push(header);
  }

  const missingRequired = EXPENSE_IMPORT_COLUMNS.filter(
    (column) => column.required && !mapping.has(column.key),
  ).map((column) => column.key);

  return {
    sheetName: sheet.sheetName,
    sheetNames: sheet.sheetNames,
    headers: sheet.headers.filter(Boolean),
    unmatchedHeaders: unmatched,
    missingRequired,
    rows: sheet.rows.map((row) => {
      const values: Partial<Record<ExpenseColumnKey, unknown>> = {};
      for (const [key, header] of mapping) values[key] = row.raw[header] ?? null;
      return { rowNumber: row.rowNumber, raw: row.raw, values };
    }),
  };
}

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();

/** "10,580.00", "₱10,580", 10580 — all the same number. */
export function parseSheetAmount(value: unknown): Money | null {
  if (typeof value === "number" && Number.isFinite(value)) return money(value.toFixed(2));
  const cleaned = text(value).replace(/[^0-9.\-()]/g, "");
  if (!cleaned) return null;
  // Accountants write a negative in brackets.
  const negative = /^\(.*\)$/.test(text(value).replace(/[^0-9.,()-]/g, ""));
  const parsed = Number.parseFloat(cleaned.replace(/[()]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return money((negative ? -parsed : parsed).toFixed(2));
}

const normaliseName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

export type ExpenseValidation = {
  rows: ExpenseRow[];
  /** Every distinct ACCOUNT value in the sheet, with what it resolves to. */
  categories: { category: string; rowCount: number; accountId: string | null; accountLabel: string | null }[];
  /** Payees that are not vendors yet. */
  newVendors: string[];
  /** Rows ready to post right now. */
  validCount: number;
  /** Rows that would be ready once every category is mapped. */
  mappableCount: number;
  /** The sheet's own total: everything but the genuinely broken rows. */
  total: Money;
  /** Rows with something wrong that mapping will not fix. */
  errorCount: number;
};

/**
 * Work out what each row means, and what is wrong with it.
 *
 * `accountMap` is the mapping chosen in the preview, keyed by the sheet's own
 * category text. It is consulted before the account's own name and aliases, so
 * a correction made in the preview beats whatever was saved last time.
 */
export async function validateExpenseRows(options: {
  companyId: string;
  rows: { rowNumber: number; raw: Record<string, unknown>; values: Partial<Record<ExpenseColumnKey, unknown>> }[];
  dateFormat?: "MDY" | "DMY" | "ISO";
  accountMap?: Record<string, string>;
}): Promise<ExpenseValidation> {
  const [accounts, vendors] = await Promise.all([
    prisma.account.findMany({
      where: { companyId: options.companyId, isActive: true },
      select: { id: true, code: true, name: true, type: true, importAliases: true },
    }),
    prisma.vendor.findMany({
      where: { companyId: options.companyId, kind: "REGULAR" },
      select: { id: true, name: true, importAliases: true },
    }),
  ]);

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountByKey = new Map<string, (typeof accounts)[number]>();
  for (const account of accounts) {
    accountByKey.set(normaliseName(account.name), account);
    accountByKey.set(normaliseName(account.code), account);
    accountByKey.set(normaliseName(`${account.code} ${account.name}`), account);
    for (const alias of account.importAliases) accountByKey.set(normaliseName(alias), account);
  }

  const vendorByKey = new Map<string, (typeof vendors)[number]>();
  for (const vendor of vendors) {
    vendorByKey.set(normaliseName(vendor.name), vendor);
    for (const alias of vendor.importAliases) vendorByKey.set(normaliseName(alias), vendor);
  }

  const rows: ExpenseRow[] = [];
  const categories = new Map<string, { rowCount: number; accountId: string | null; accountLabel: string | null }>();
  const newVendors = new Set<string>();
  let total = money(0);

  for (const row of options.rows) {
    const issues: ExpenseIssue[] = [];
    const value = (key: ExpenseColumnKey) => text(row.values[key]);

    // A sheet kept by hand has blank lines and the odd subtotal. A row with
    // nothing in it is skipped silently rather than reported as broken.
    const isEmpty = EXPENSE_IMPORT_COLUMNS.every((column) => !value(column.key));
    if (isEmpty) continue;

    const date = parseSheetDate(row.values.date, options.dateFormat ?? "MDY");
    if (!value("date")) issues.push({ column: "date", message: "No date", severity: "error" });
    else if (!date) {
      issues.push({
        column: "date",
        message: `"${value("date")}" is not a date this can read`,
        severity: "error",
      });
    }

    const description = value("description");
    if (!description) {
      issues.push({ column: "description", message: "No description", severity: "error" });
    }

    const amount = parseSheetAmount(row.values.amount);
    if (!value("amount")) {
      issues.push({ column: "amount", message: "No amount", severity: "error" });
    } else if (!amount) {
      issues.push({
        column: "amount",
        message: `"${value("amount")}" is not a number`,
        severity: "error",
      });
    } else if (amount.lessThanOrEqualTo(0)) {
      // The ledger refuses it anyway; saying so here beats a failed commit.
      issues.push({
        column: "amount",
        message: "An expense must be more than zero. A refund is recorded separately.",
        severity: "error",
      });
    }

    // --- the sheet's category, mapped to a real account -------------------
    const category = value("account");
    let account: { id: string; code: string; name: string } | null = null;
    if (!category) {
      issues.push({ column: "account", message: "No account", severity: "error" });
    } else {
      const mapped = options.accountMap?.[category] ?? options.accountMap?.[normaliseName(category)];
      const resolved = mapped ? accountById.get(mapped) : accountByKey.get(normaliseName(category));
      if (resolved) account = resolved;
      else {
        issues.push({
          column: "account",
          message: `No account matches "${category}" — choose one above`,
          severity: "error",
          code: "unmappedAccount",
        });
      }
    }
    if (category) {
      const seen = categories.get(category) ?? { rowCount: 0, accountId: null, accountLabel: null };
      seen.rowCount += 1;
      if (account) {
        seen.accountId = account.id;
        seen.accountLabel = `${account.code} ${account.name}`;
      }
      categories.set(category, seen);
    }

    // --- the payee --------------------------------------------------------
    const vendorName = value("name");
    const vendor = vendorName ? vendorByKey.get(normaliseName(vendorName)) : undefined;
    if (vendorName && !vendor) newVendors.add(vendorName);

    const errors = issues.filter((issue) => issue.severity === "error");
    const blocked = errors.length > 0;
    // Waiting on a mapping is not the same as being wrong, so such a row still
    // counts towards the file's total and towards what is about to import.
    const onlyUnmapped = blocked && errors.every((issue) => issue.code === "unmappedAccount");
    if ((!blocked || onlyUnmapped) && amount && amount.greaterThan(0)) total = total.plus(amount);

    rows.push({
      rowNumber: row.rowNumber,
      raw: row.raw,
      values: row.values,
      issues,
      planned:
        blocked || !date || !amount || !account
          ? null
          : {
              date,
              amount,
              description,
              reference: value("num") || null,
              receiptUrl: value("fileLink") || null,
              category,
              accountId: account.id,
              accountLabel: `${account.code} ${account.name}`,
              vendorName: vendorName || null,
              vendorId: vendor?.id ?? null,
              vendorIsNew: Boolean(vendorName) && !vendor,
            },
    });
  }

  const realError = (row: ExpenseRow) =>
    row.issues.some((issue) => issue.severity === "error" && issue.code !== "unmappedAccount");

  return {
    rows,
    categories: [...categories.entries()]
      .map(([category, seen]) => ({ category, ...seen }))
      .sort((a, b) => b.rowCount - a.rowCount),
    newVendors: [...newVendors].sort(),
    total,
    validCount: rows.filter((row) => row.planned).length,
    mappableCount: rows.filter((row) => row.planned || !realError(row)).length,
    errorCount: rows.filter(realError).length,
  };
}

export type StagedExpenseBatch = {
  batchId: string;
  sheet: ExpenseSheet;
  validation: ExpenseValidation;
  duplicateOf: { id: string; uploadedAt: Date; createdCount: number } | null;
};

export async function stageExpenseImport(options: {
  companyId: string;
  fileName: string;
  bytes: Buffer;
  sheetName?: string | null;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
}): Promise<StagedExpenseBatch> {
  const sheet = await readExpenseSheet({
    bytes: options.bytes,
    fileName: options.fileName,
    sheetName: options.sheetName,
  });

  if (sheet.missingRequired.length > 0) {
    throw new PostingError(
      `That sheet is missing required columns: ${sheet.missingRequired
        .map((key) => EXPENSE_IMPORT_COLUMNS.find((column) => column.key === key)?.header ?? key)
        .join(", ")}.`,
    );
  }
  if (sheet.rows.length === 0) throw new PostingError("That sheet has no data rows.");

  const fileHash = hashFile(options.bytes);
  // Re-importing the same file is warned about loudly, not blocked: a
  // corrected sheet is a legitimate second run.
  const previous = await prisma.importBatch.findFirst({
    where: { companyId: options.companyId, kind: "EXPENSE", fileHash, status: "COMMITTED" },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, uploadedAt: true, createdCount: true },
  });

  const validation = await validateExpenseRows({
    companyId: options.companyId,
    rows: sheet.rows,
    dateFormat: options.dateFormat,
  });

  const batch = await prisma.importBatch.create({
    data: {
      companyId: options.companyId,
      kind: "EXPENSE",
      status: "PARSED",
      fileName: options.fileName,
      fileHash,
      sheetName: sheet.sheetName,
      rowCount: validation.rows.length,
      uploadedByUserId: options.userId ?? null,
      rows: {
        create: validation.rows.map((row) => ({
          rowNumber: row.rowNumber,
          rawJson: row.raw as Prisma.InputJsonValue,
          parsedJson: row.planned
            ? ({
                date: row.planned.date.toISOString(),
                amount: row.planned.amount.toString(),
                description: row.planned.description,
                category: row.planned.category,
                accountLabel: row.planned.accountLabel,
                vendorName: row.planned.vendorName,
              } as Prisma.InputJsonValue)
            : undefined,
          status: row.issues.some((issue) => issue.severity === "error")
            ? "ERROR"
            : row.issues.some((issue) => issue.severity === "warning")
              ? "WARNING"
              : "VALID",
          issues: row.issues as unknown as Prisma.InputJsonValue,
        })),
      },
    },
  });

  // The original file is kept: a batch must be able to show its source.
  const fileKey = storageKeys.importFile(options.companyId, batch.id, options.fileName);
  await storage().put(fileKey, options.bytes);
  await prisma.importBatch.update({ where: { id: batch.id }, data: { fileKey } });

  return { batchId: batch.id, sheet, validation, duplicateOf: previous };
}

/** How many rows one commit request will attempt before handing back. */
export const COMMIT_CHUNK = 60;

export type CommitProgress = {
  imported: number;
  remaining: number;
  failed: { rowNumber: number; message: string }[];
  done: boolean;
};

/**
 * Post a chunk of the batch, and say what is left.
 *
 * Each row is its own expense and its own journal entry, posted through the
 * same `recordExpense` the manual screen uses — no faster path that could
 * drift from it. That costs a handful of round trips per row, so a file of
 * five hundred cannot be done in one request on a host that kills a function
 * at sixty seconds. The caller keeps calling until `done`, and rows already
 * imported are skipped, so continuing is always safe.
 *
 * A row that the ledger refuses — a closed period, most likely — is recorded
 * against its own row and the rest carry on. Stopping the whole import because
 * one row is dated into a locked month would be the wrong trade for a file
 * covering fifteen months.
 */
export async function commitExpenseChunk(options: {
  companyId: string;
  batchId: string;
  accountMap: Record<string, string>;
  paymentAccountId: string;
  createVendors: boolean;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
  limit?: number;
}): Promise<CommitProgress> {
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId, kind: "EXPENSE" },
    include: { rows: { orderBy: { rowNumber: "asc" } } },
  });
  if (!batch) throw new PostingError("Import batch not found in this company");
  if (batch.status === "COMMITTED") throw new PostingError("This batch has already been imported");
  if (batch.status === "DISCARDED") throw new PostingError("This batch was discarded");

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: options.companyId },
    select: { baseCurrency: true },
  });
  const currency = company.baseCurrency;

  const paymentAccount = await prisma.account.findFirst({
    where: { id: options.paymentAccountId, companyId: options.companyId, isActive: true },
    select: { id: true },
  });
  if (!paymentAccount) throw new PostingError("Choose the account the money came out of");

  // Rows that have not been imported yet, oldest first.
  const pending = batch.rows.filter((row) => row.status !== "IMPORTED");
  const validation = await validateExpenseRows({
    companyId: options.companyId,
    rows: pending.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: rawToValues(row.rawJson as Record<string, unknown>),
    })),
    dateFormat: options.dateFormat,
    accountMap: options.accountMap,
  });

  const ready = validation.rows.filter((row) => row.planned);
  const slice = ready.slice(0, options.limit ?? COMMIT_CHUNK);

  // Vendors first, outside the per-row work: a payee appears on dozens of rows
  // and must become one vendor, not dozens.
  const vendorIds = new Map<string, string>();
  if (options.createVendors) {
    for (const row of slice) {
      const name = row.planned?.vendorName;
      if (!name || row.planned?.vendorId || vendorIds.has(normaliseName(name))) continue;
      const existing = await prisma.vendor.findFirst({
        where: { companyId: options.companyId, kind: "REGULAR", name },
        select: { id: true },
      });
      const vendor =
        existing ??
        (await prisma.vendor.create({
          // The sheet gives a name and nothing else, which is all a vendor
          // needs here; the rest is filled in when somebody has a reason to.
          data: {
            companyId: options.companyId,
            kind: "REGULAR",
            name,
            defaultCurrency: currency,
          },
          select: { id: true },
        }));
      vendorIds.set(normaliseName(name), vendor.id);
    }
  }

  const failed: CommitProgress["failed"] = [];
  let imported = 0;

  for (const row of slice) {
    const planned = row.planned!;
    const vendorId =
      planned.vendorId ??
      (planned.vendorName ? (vendorIds.get(normaliseName(planned.vendorName)) ?? null) : null);

    try {
      const { expense } = await recordExpense({
        companyId: options.companyId,
        kind: "DIRECT",
        vendorId,
        date: planned.date,
        currency,
        amount: planned.amount,
        expenseAccountId: planned.accountId!,
        paymentAccountId: options.paymentAccountId,
        // The payee is on the expense's vendor; the description is what the
        // sheet said it was for, with the receipt's file name beside it.
        description: planned.description,
        reference: planned.reference,
        receiptUrl: planned.receiptUrl,
        userId: options.userId,
      });
      await prisma.importRow.updateMany({
        where: { importBatchId: batch.id, rowNumber: row.rowNumber },
        data: { status: "IMPORTED", expenseId: expense.id },
      });
      imported += 1;
    } catch (error) {
      failed.push({
        rowNumber: row.rowNumber,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = Math.max(0, ready.length - slice.length);
  const done = remaining === 0;

  if (done) {
    const importedRows = await prisma.importRow.count({
      where: { importBatchId: batch.id, status: "IMPORTED" },
    });
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: "COMMITTED",
        committedAt: new Date(),
        createdCount: importedRows,
        skippedCount: batch.rows.length - importedRows,
      },
    });

    await rememberAccountAliases(options.companyId, options.accountMap);

    await writeAudit({
      companyId: options.companyId,
      userId: options.userId,
      action: "expense_import.committed",
      entityType: "ImportBatch",
      entityId: batch.id,
      summary: `${importedRows} expenses from ${batch.fileName}`,
    });
  }

  return { imported, remaining, failed, done };
}

/**
 * Keep the mapping, so next month's sheet needs none.
 *
 * Saved against the account rather than the batch: the alias is a fact about
 * what this company calls that account, and it should work for any sheet that
 * uses the same word.
 */
async function rememberAccountAliases(companyId: string, accountMap: Record<string, string>) {
  for (const [category, accountId] of Object.entries(accountMap)) {
    if (!category.trim()) continue;
    const account = await prisma.account.findFirst({
      where: { id: accountId, companyId },
      select: { id: true, name: true, code: true, importAliases: true },
    });
    if (!account) continue;
    // Already matched by its own name or code, so an alias would add nothing.
    if (
      normaliseName(account.name) === normaliseName(category) ||
      normaliseName(account.code) === normaliseName(category)
    ) {
      continue;
    }
    if (account.importAliases.some((alias) => normaliseName(alias) === normaliseName(category))) {
      continue;
    }
    await prisma.account.update({
      where: { id: account.id },
      data: { importAliases: [...account.importAliases, category] },
    });
  }
}

/** Reverse the sheet's headers back into column values for re-validation. */
function rawToValues(raw: Record<string, unknown>) {
  const values: Partial<Record<ExpenseColumnKey, unknown>> = {};
  for (const [header, value] of Object.entries(raw)) {
    const column = expenseColumnFor(header);
    if (column && values[column.key] === undefined) values[column.key] = value;
  }
  return values;
}

export { normaliseHeader };
