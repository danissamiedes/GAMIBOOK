import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { storage, storageKeys } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import { PostingError } from "@/lib/errors";
import { money, type Money } from "@/lib/money";
import { recordExpense } from "@/lib/payables/expenses";
import {
  CONSULTANT_BILL_IMPORT_COLUMNS,
  consultantBillColumnFor,
  normaliseHeader,
  type ConsultantBillColumnKey,
} from "./consultant-bill-columns";
import { hashFile, parseSheetAmount } from "./expenses";
import { readWorkbook } from "./parse";
import { parseSheetDate } from "./validate";

/**
 * Importing a month of consultant bills from a spreadsheet (SPEC §8.3).
 *
 * The expense import, for a document that is owed rather than paid. The
 * shape is deliberately the same — upload, map the sheet's categories once,
 * review, commit in resumable chunks — because it is the same job and
 * somebody who has done one should not have to learn the other.
 *
 * Three things a bill does differently, and all three come from it being a
 * debt rather than a payment.
 *
 * **It must say who is owed.** An expense can be recorded with no payee; a
 * bill cannot, and the ledger refuses one. So the consultant column is
 * required, and a name nobody recognises stops its row rather than quietly
 * inventing a person.
 *
 * **It has a due date rather than a payment account.** No money moves, so
 * there is nothing to pay it from. Where the sheet does not say when it falls
 * due, the consultant's own payment terms do.
 *
 * **It is paid later, on its own screen.** Committing posts the cost and the
 * liability and stops there.
 */

export type ConsultantBillIssue = {
  column: ConsultantBillColumnKey | "row";
  message: string;
  severity: "error" | "warning";
  /**
   * The two problems the preview exists to solve. Neither is a broken row:
   * one is a category nobody has mapped yet, the other a consultant nobody
   * has agreed to create. Counting either as damage would tell somebody
   * their file was unusable at the moment they were about to make it usable.
   */
  code?: "unmappedAccount" | "unknownConsultant";
};

/** One row of the sheet, understood as far as it can be. */
export type ConsultantBillRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  values: Partial<Record<ConsultantBillColumnKey, unknown>>;
  issues: ConsultantBillIssue[];
  planned: {
    date: Date;
    /** From the sheet, or worked out from the consultant's terms. */
    dueDate: Date;
    /** True when the terms decided it rather than the sheet. */
    dueDateFromTerms: boolean;
    amount: Money;
    description: string;
    reference: string;
    receiptUrl: string | null;
    /** What the sheet called it, before mapping. */
    category: string;
    accountId: string;
    accountLabel: string;
    consultantName: string;
    consultantId: string | null;
    /** True when committing would have to create the consultant. */
    consultantIsNew: boolean;
  } | null;
};

export type ConsultantBillSheet = {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  unmatchedHeaders: string[];
  missingRequired: ConsultantBillColumnKey[];
  rows: {
    rowNumber: number;
    raw: Record<string, unknown>;
    values: Partial<Record<ConsultantBillColumnKey, unknown>>;
  }[];
};

/** Read the workbook and label its columns, with no opinion about contents. */
export async function readConsultantBillSheet(options: {
  bytes: Buffer;
  fileName: string;
  sheetName?: string | null;
}): Promise<ConsultantBillSheet> {
  const sheet = await readWorkbook(options);

  const mapping = new Map<ConsultantBillColumnKey, string>();
  const unmatched: string[] = [];
  for (const header of sheet.headers) {
    if (!header) continue;
    const column = consultantBillColumnFor(header);
    if (column && !mapping.has(column.key)) mapping.set(column.key, header);
    else if (!column) unmatched.push(header);
  }

  const missingRequired = CONSULTANT_BILL_IMPORT_COLUMNS.filter(
    (column) => column.required && !mapping.has(column.key),
  ).map((column) => column.key);

  return {
    sheetName: sheet.sheetName,
    sheetNames: sheet.sheetNames,
    headers: sheet.headers.filter(Boolean),
    unmatchedHeaders: unmatched,
    missingRequired,
    rows: sheet.rows.map((row) => {
      const values: Partial<Record<ConsultantBillColumnKey, unknown>> = {};
      for (const [key, header] of mapping) values[key] = row.raw[header] ?? null;
      return { rowNumber: row.rowNumber, raw: row.raw, values };
    }),
  };
}

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();

const normaliseName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** The bill date plus the consultant's agreed terms, as a plain date. */
function dueFromTerms(date: Date, paymentTermsDays: number): Date {
  return new Date(date.getTime() + paymentTermsDays * 86_400_000);
}

export type ConsultantBillValidation = {
  rows: ConsultantBillRow[];
  /** Every distinct ACCOUNT value in the sheet, with what it resolves to. */
  categories: {
    category: string;
    rowCount: number;
    accountId: string | null;
    accountLabel: string | null;
  }[];
  /** Names in the sheet that are not consultants yet, with how many rows each. */
  newConsultants: { name: string; rowCount: number }[];
  /** Rows ready to post right now. */
  validCount: number;
  /** Rows that would be ready once the categories are mapped and names approved. */
  mappableCount: number;
  /** The sheet's own total: everything but the genuinely broken rows. */
  total: Money;
  /** Rows with something wrong that mapping and approving will not fix. */
  errorCount: number;
};

/**
 * Work out what each row means, and what is wrong with it.
 *
 * `accountMap` is the mapping chosen in the preview, keyed by the sheet's own
 * category text, and is consulted before the account's own name and aliases
 * so that a correction made in the preview beats whatever was saved last
 * time. `createConsultants` says whether an unfamiliar name is an answered
 * question or an open one — until it is ticked, such a row is held back.
 */
export async function validateConsultantBillRows(options: {
  companyId: string;
  rows: {
    rowNumber: number;
    raw: Record<string, unknown>;
    values: Partial<Record<ConsultantBillColumnKey, unknown>>;
  }[];
  dateFormat?: "MDY" | "DMY" | "ISO";
  accountMap?: Record<string, string>;
  createConsultants?: boolean;
  /** Terms to assume for a consultant that does not exist yet. */
  defaultPaymentTermsDays?: number;
}): Promise<ConsultantBillValidation> {
  const [accounts, consultants] = await Promise.all([
    prisma.account.findMany({
      where: { companyId: options.companyId, isActive: true },
      select: { id: true, code: true, name: true, type: true, importAliases: true },
    }),
    prisma.vendor.findMany({
      where: { companyId: options.companyId, kind: "CONSULTANT" },
      select: { id: true, name: true, importAliases: true, paymentTermsDays: true },
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

  const consultantByKey = new Map<string, (typeof consultants)[number]>();
  for (const consultant of consultants) {
    consultantByKey.set(normaliseName(consultant.name), consultant);
    for (const alias of consultant.importAliases) {
      consultantByKey.set(normaliseName(alias), consultant);
    }
  }

  const defaultTerms = options.defaultPaymentTermsDays ?? 30;
  const rows: ConsultantBillRow[] = [];
  const categories = new Map<
    string,
    { rowCount: number; accountId: string | null; accountLabel: string | null }
  >();
  const newConsultants = new Map<string, number>();
  let total = money(0);

  for (const row of options.rows) {
    const issues: ConsultantBillIssue[] = [];
    const value = (key: ConsultantBillColumnKey) => text(row.values[key]);

    // A sheet kept by hand has blank lines and the odd subtotal. A row with
    // nothing in it is skipped silently rather than reported as broken.
    const isEmpty = CONSULTANT_BILL_IMPORT_COLUMNS.every((column) => !value(column.key));
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

    // Every bill carries a reference (SPEC §7.1), and a sheet is no
    // exception: a row with no NUM is rejected here rather than refused one
    // at a time by the ledger halfway through the commit.
    if (!value("num")) {
      issues.push({
        column: "num",
        message: "No reference number — fill in NUM and upload again",
        severity: "error",
      });
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
        message: "A bill must be more than zero. A credit note is recorded separately.",
        severity: "error",
      });
    }

    // --- the sheet's category, mapped to a real account -------------------
    const category = value("account");
    let account: { id: string; code: string; name: string } | null = null;
    if (!category) {
      issues.push({ column: "account", message: "No account", severity: "error" });
    } else {
      const mapped =
        options.accountMap?.[category] ?? options.accountMap?.[normaliseName(category)];
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
      const seen = categories.get(category) ?? {
        rowCount: 0,
        accountId: null,
        accountLabel: null,
      };
      seen.rowCount += 1;
      if (account) {
        seen.accountId = account.id;
        seen.accountLabel = `${account.code} ${account.name}`;
      }
      categories.set(category, seen);
    }

    // --- who is owed ------------------------------------------------------
    //
    // Unlike the expense sheet, this cannot be left out: a bill with no
    // party is a debt owed to nobody, and the ledger says so.
    const consultantName = value("consultant");
    const consultant = consultantName
      ? consultantByKey.get(normaliseName(consultantName))
      : undefined;
    if (!consultantName) {
      issues.push({
        column: "consultant",
        message: "No consultant — a bill has to say who is owed",
        severity: "error",
      });
    } else if (!consultant) {
      newConsultants.set(consultantName, (newConsultants.get(consultantName) ?? 0) + 1);
      if (!options.createConsultants) {
        issues.push({
          column: "consultant",
          message: `"${consultantName}" is not a consultant yet — tick the box to create them`,
          severity: "error",
          code: "unknownConsultant",
        });
      }
    }

    // --- when it falls due ------------------------------------------------
    const terms = consultant?.paymentTermsDays ?? defaultTerms;
    const statedDue = value("dueDate")
      ? parseSheetDate(row.values.dueDate, options.dateFormat ?? "MDY")
      : null;
    if (value("dueDate") && !statedDue) {
      issues.push({
        column: "dueDate",
        message: `"${value("dueDate")}" is not a date this can read`,
        severity: "error",
      });
    } else if (statedDue && date && statedDue < date) {
      // Not refused — a bill can arrive already overdue — but worth saying,
      // because far more often it is the two columns typed the wrong way
      // round.
      issues.push({
        column: "dueDate",
        message: "Due before it is dated. Check the columns are the right way round.",
        severity: "warning",
      });
    }
    const dueDate = statedDue ?? (date ? dueFromTerms(date, terms) : null);

    const errors = issues.filter((issue) => issue.severity === "error");
    const blocked = errors.length > 0;
    // Waiting on a mapping or on a name being approved is not the same as
    // being wrong, so such a row still counts towards the file's total and
    // towards what is about to import.
    const onlyPending =
      blocked &&
      errors.every(
        (issue) => issue.code === "unmappedAccount" || issue.code === "unknownConsultant",
      );
    if ((!blocked || onlyPending) && amount && amount.greaterThan(0)) total = total.plus(amount);

    rows.push({
      rowNumber: row.rowNumber,
      raw: row.raw,
      values: row.values,
      issues,
      planned:
        blocked || !date || !dueDate || !amount || !account || !consultantName
          ? null
          : {
              date,
              dueDate,
              dueDateFromTerms: !statedDue,
              amount,
              description,
              reference: value("num"),
              receiptUrl: value("fileLink") || null,
              category,
              accountId: account.id,
              accountLabel: `${account.code} ${account.name}`,
              consultantName,
              consultantId: consultant?.id ?? null,
              consultantIsNew: !consultant,
            },
    });
  }

  const realError = (row: ConsultantBillRow) =>
    row.issues.some(
      (issue) =>
        issue.severity === "error" &&
        issue.code !== "unmappedAccount" &&
        issue.code !== "unknownConsultant",
    );

  return {
    rows,
    categories: [...categories.entries()]
      .map(([category, seen]) => ({ category, ...seen }))
      .sort((a, b) => b.rowCount - a.rowCount),
    newConsultants: [...newConsultants.entries()]
      .map(([name, rowCount]) => ({ name, rowCount }))
      .sort((a, b) => b.rowCount - a.rowCount || a.name.localeCompare(b.name)),
    total,
    validCount: rows.filter((row) => row.planned).length,
    mappableCount: rows.filter((row) => row.planned || !realError(row)).length,
    errorCount: rows.filter(realError).length,
  };
}

export type StagedConsultantBillBatch = {
  batchId: string;
  sheet: ConsultantBillSheet;
  validation: ConsultantBillValidation;
  duplicateOf: { id: string; uploadedAt: Date; createdCount: number } | null;
};

export async function stageConsultantBillImport(options: {
  companyId: string;
  fileName: string;
  bytes: Buffer;
  sheetName?: string | null;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
}): Promise<StagedConsultantBillBatch> {
  const sheet = await readConsultantBillSheet({
    bytes: options.bytes,
    fileName: options.fileName,
    sheetName: options.sheetName,
  });

  if (sheet.missingRequired.length > 0) {
    throw new PostingError(
      `That sheet is missing required columns: ${sheet.missingRequired
        .map(
          (key) =>
            CONSULTANT_BILL_IMPORT_COLUMNS.find((column) => column.key === key)?.header ?? key,
        )
        .join(", ")}.`,
    );
  }
  if (sheet.rows.length === 0) throw new PostingError("That sheet has no data rows.");

  const fileHash = hashFile(options.bytes);
  // Re-importing the same file is warned about loudly, not blocked: a
  // corrected sheet is a legitimate second run.
  const previous = await prisma.importBatch.findFirst({
    where: {
      companyId: options.companyId,
      kind: "CONSULTANT_BILL",
      fileHash,
      status: "COMMITTED",
    },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, uploadedAt: true, createdCount: true },
  });

  const validation = await validateConsultantBillRows({
    companyId: options.companyId,
    rows: sheet.rows,
    dateFormat: options.dateFormat,
  });

  const batch = await prisma.importBatch.create({
    data: {
      companyId: options.companyId,
      kind: "CONSULTANT_BILL",
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
                dueDate: row.planned.dueDate.toISOString(),
                amount: row.planned.amount.toString(),
                description: row.planned.description,
                category: row.planned.category,
                accountLabel: row.planned.accountLabel,
                consultantName: row.planned.consultantName,
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

/**
 * How long one request keeps posting before handing back, whatever it has
 * reached by then. The reasoning is the expense import's, and so is the
 * number: a fixed row count is a guess that is wrong on a slow day, and
 * being wrong means the host kills the function mid-file.
 */
export const COMMIT_BUDGET_MS = 45_000;

export type CommitProgress = {
  imported: number;
  remaining: number;
  failed: { rowNumber: number; message: string }[];
  done: boolean;
};

/** A row the ledger refused once; it is not attempted again. */
const POSTING_FAILED = "postingFailed";

function hasPostingFailure(issues: unknown): boolean {
  return (
    Array.isArray(issues) &&
    issues.some(
      (issue) =>
        typeof issue === "object" &&
        issue !== null &&
        (issue as { code?: string }).code === POSTING_FAILED,
    )
  );
}

/**
 * Post a chunk of the batch, and say what is left.
 *
 * Each row is its own bill and its own journal entry, posted through the same
 * `recordExpense` the manual screen uses — no faster path that could drift
 * from it. The caller keeps calling until `done`, and rows already imported
 * are skipped, so continuing is always safe.
 *
 * A row the ledger refuses — a closed period, most likely — is recorded
 * against its own row and the rest carry on.
 */
export async function commitConsultantBillChunk(options: {
  companyId: string;
  batchId: string;
  accountMap: Record<string, string>;
  createConsultants: boolean;
  dateFormat?: "MDY" | "DMY" | "ISO";
  userId?: string | null;
  limit?: number;
  /** Stop and hand back after this long. Zero means one row and no more. */
  budgetMs?: number;
}): Promise<CommitProgress> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? COMMIT_BUDGET_MS;
  const batch = await prisma.importBatch.findFirst({
    where: { id: options.batchId, companyId: options.companyId, kind: "CONSULTANT_BILL" },
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

  // Rows that have not been imported yet, oldest first. A row the ledger has
  // already refused is left out: retrying it at the head of every chunk would
  // spend the whole budget failing in the same way.
  const pending = batch.rows.filter(
    (row) => row.status !== "IMPORTED" && !hasPostingFailure(row.issues),
  );
  const validation = await validateConsultantBillRows({
    companyId: options.companyId,
    rows: pending.map((row) => ({
      rowNumber: row.rowNumber,
      raw: row.rawJson as Record<string, unknown>,
      values: rawToValues(row.rawJson as Record<string, unknown>),
    })),
    dateFormat: options.dateFormat,
    accountMap: options.accountMap,
    createConsultants: options.createConsultants,
  });

  const ready = validation.rows.filter((row) => row.planned);
  const slice = ready.slice(0, options.limit ?? COMMIT_CHUNK);

  // A consultant appears on several rows and must become one record, not
  // several, so each name is looked up once and kept. It happens as the rows
  // are reached rather than up front, so the clock below covers it too.
  const consultantIds = new Map<string, string>();
  const consultantFor = async (name: string): Promise<string> => {
    const key = normaliseName(name);
    const known = consultantIds.get(key);
    if (known) return known;
    const existing = await prisma.vendor.findFirst({
      where: { companyId: options.companyId, kind: "CONSULTANT", name },
      select: { id: true },
    });
    const consultant =
      existing ??
      (await prisma.vendor.create({
        // The sheet gives a name and nothing else, which is all a consultant
        // needs to be owed money; the rate, the email and the terms are
        // filled in when somebody has a reason to.
        data: {
          companyId: options.companyId,
          kind: "CONSULTANT",
          name,
          defaultCurrency: currency,
        },
        select: { id: true },
      }));
    consultantIds.set(key, consultant.id);
    return consultant.id;
  };

  const failed: CommitProgress["failed"] = [];
  let imported = 0;
  let attempted = 0;

  for (const row of slice) {
    // Always do one row, so a budget of nothing still makes progress and the
    // import cannot stall; after that, stop while there is time left to
    // answer. The caller comes straight back for the next chunk.
    if (attempted > 0 && Date.now() - startedAt >= budgetMs) break;
    attempted += 1;

    const planned = row.planned!;
    const consultantId = planned.consultantId ?? (await consultantFor(planned.consultantName));

    try {
      const { expense } = await recordExpense({
        companyId: options.companyId,
        kind: "BILL",
        vendorId: consultantId,
        date: planned.date,
        dueDate: planned.dueDate,
        currency,
        amount: planned.amount,
        expenseAccountId: planned.accountId,
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
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ rowNumber: row.rowNumber, message });
      // Written down on the row, both so the rejects file can say why and so
      // the next chunk does not spend its budget on a row that will refuse
      // again for the same reason.
      await prisma.importRow.updateMany({
        where: { importBatchId: batch.id, rowNumber: row.rowNumber },
        data: {
          status: "ERROR",
          issues: [
            ...row.issues,
            { column: "amount", message, severity: "error", code: POSTING_FAILED },
          ] as unknown as Prisma.InputJsonValue,
        },
      });
    }
  }

  const remaining = Math.max(0, ready.length - attempted);
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
      action: "consultant_bill_import.committed",
      entityType: "ImportBatch",
      entityId: batch.id,
      summary: `${importedRows} consultant bills from ${batch.fileName}`,
    });
  }

  return { imported, remaining, failed, done };
}

/**
 * Keep the mapping, so next month's sheet needs none.
 *
 * Saved against the account rather than the batch: the alias is a fact about
 * what this company calls that account, and it should work for any sheet
 * that uses the same word — the expense sheet included.
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
  const values: Partial<Record<ConsultantBillColumnKey, unknown>> = {};
  for (const [header, value] of Object.entries(raw)) {
    const column = consultantBillColumnFor(header);
    if (column && values[column.key] === undefined) values[column.key] = value;
  }
  return values;
}

export { normaliseHeader };
