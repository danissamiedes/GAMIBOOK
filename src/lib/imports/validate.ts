import { prisma } from "@/lib/db";
import { money, parseMoney, toCents, type Money } from "@/lib/money";
import { COLUMN_LABEL, type ColumnKey } from "./columns";
import type { RawRow } from "./parse";

/**
 * Turning sheet rows into work orders (SPEC §8.3).
 *
 * The grouping rule is the heart of it: `Line No.` 1 opens a new work order
 * for that consultant, and 2, 3 … attach to the one they currently have open.
 * Grouping is tracked per consultant, so rows for different people may
 * interleave without breaking a run.
 */

export type Severity = "error" | "warning" | "notice";
export type Issue = { column: ColumnKey | "row"; message: string; severity: Severity };

export type ValidatedRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  issues: Issue[];
  /** Null when the row cannot be turned into a line. */
  line: {
    consultantId: string;
    consultantName: string;
    lineNo: number;
    description: string;
    accountId: string;
    accountLabel: string;
    quantity: Money;
    rate: Money;
    amount: Money;
    issueDate: Date;
    /** Which group this line belongs to, once grouping is resolved. */
    groupKey: string;
  } | null;
};

export type PlannedWorkOrder = {
  groupKey: string;
  consultantId: string;
  consultantName: string;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  lines: { rowNumber: number; description: string; quantity: Money; rate: Money; amount: Money; accountId: string }[];
  total: Money;
  issues: Issue[];
};

export type ValidationResult = {
  rows: ValidatedRow[];
  workOrders: PlannedWorkOrder[];
  counts: { valid: number; warning: number; error: number };
};

const has = (issues: Issue[], severity: Severity) => issues.some((issue) => issue.severity === severity);

/**
 * Dates: Excel serials arrive as real dates from the parser; text is read in
 * the format the sheet actually uses (`8/15/2026` → 15 August 2026). A date
 * that could be read two ways is never resolved by guessing (SPEC §8.3).
 */
export function parseSheetDate(value: unknown, format: "MDY" | "DMY" | "ISO" = "MDY"): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial: day 1 is 1 January 1900, with the well-known 1900 leap bug.
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + Math.round(value) * 86_400_000);
  }
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));

  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (slash) {
    const first = Number(slash[1]);
    const second = Number(slash[2]);
    let year = Number(slash[3]);
    if (year < 100) year += 2000;
    const [month, day] =
      format === "DMY" ? [second, first] : format === "ISO" ? [second, first] : [first, second];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function normaliseName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function validateRows(options: {
  companyId: string;
  rows: RawRow[];
  dateFormat?: "MDY" | "DMY" | "ISO";
  /** Manual mappings made in the review screen: sheet name → consultant id. */
  consultantOverrides?: Record<string, string>;
}): Promise<ValidationResult> {
  const [consultants, accounts, company] = await Promise.all([
    prisma.vendor.findMany({
      where: { companyId: options.companyId, kind: "CONSULTANT" },
      select: {
        id: true,
        name: true,
        isActive: true,
        importAliases: true,
        externalRef: true,
        defaultCurrency: true,
        defaultAccountId: true,
        paymentTermsDays: true,
      },
    }),
    prisma.account.findMany({
      where: { companyId: options.companyId },
      select: { id: true, code: true, name: true, isActive: true },
    }),
    prisma.company.findUniqueOrThrow({
      where: { id: options.companyId },
      select: { baseCurrency: true },
    }),
  ]);

  const consultantByName = new Map<string, (typeof consultants)[number]>();
  for (const consultant of consultants) {
    consultantByName.set(normaliseName(consultant.name), consultant);
    for (const alias of consultant.importAliases) consultantByName.set(normaliseName(alias), consultant);
    if (consultant.externalRef) consultantByName.set(normaliseName(consultant.externalRef), consultant);
  }

  const accountByKey = new Map<string, (typeof accounts)[number]>();
  for (const account of accounts) {
    accountByKey.set(normaliseName(account.name), account);
    accountByKey.set(normaliseName(account.code), account);
    accountByKey.set(normaliseName(`${account.code} ${account.name}`), account);
  }

  const validated: ValidatedRow[] = [];
  /** The work order each consultant currently has open, as runs are read. */
  const openGroup = new Map<string, string>();
  const groups = new Map<string, PlannedWorkOrder>();

  for (const row of options.rows) {
    const issues: Issue[] = [];
    const value = (key: ColumnKey) => row.values[key];
    const text = (key: ColumnKey) => {
      const raw = value(key);
      return raw === null || raw === undefined ? "" : String(raw).trim();
    };

    // --- consultant -------------------------------------------------------
    const consultantName = text("consultantName");
    const override = options.consultantOverrides?.[normaliseName(consultantName)];
    const consultant = override
      ? consultants.find((candidate) => candidate.id === override)
      : consultantByName.get(normaliseName(consultantName));

    if (!consultantName) {
      issues.push({ column: "consultantName", message: "No consultant named", severity: "error" });
    } else if (!consultant) {
      issues.push({
        column: "consultantName",
        message: `No consultant matches "${consultantName}" — map it below and the choice is remembered`,
        severity: "error",
      });
    } else if (!consultant.isActive) {
      issues.push({
        column: "consultantName",
        message: `${consultant.name} is inactive`,
        severity: "error",
      });
    }

    // --- account ----------------------------------------------------------
    const accountText = text("account");
    const account = accountByKey.get(normaliseName(accountText));
    if (!accountText) {
      issues.push({ column: "account", message: "No account named", severity: "error" });
    } else if (!account) {
      issues.push({
        column: "account",
        message: `No account matches "${accountText}"`,
        severity: "error",
      });
    } else if (!account.isActive) {
      issues.push({ column: "account", message: `${account.name} is inactive`, severity: "error" });
    }

    // --- numbers ----------------------------------------------------------
    const quantity = parseMoney(value("quantity") as string | number | null);
    if (quantity === null) {
      issues.push({ column: "quantity", message: "Quantity is not a number", severity: "error" });
    } else if (quantity.isZero()) {
      issues.push({ column: "quantity", message: "Quantity is zero", severity: "error" });
    }

    // A negative rate is legitimate: it is how a deduction is written.
    const rate = parseMoney(value("rate") as string | number | null);
    if (rate === null) {
      issues.push({ column: "rate", message: "Rate is not a number", severity: "error" });
    } else if (rate.isZero()) {
      issues.push({ column: "rate", message: "Rate is zero", severity: "error" });
    }

    const computed = quantity && rate ? toCents(quantity.times(rate)) : null;
    const statedAmount = parseMoney(value("amount") as string | number | null);
    if (computed && statedAmount && !statedAmount.minus(computed).abs().lessThanOrEqualTo("0.01")) {
      issues.push({
        column: "amount",
        message: `Amount ${statedAmount.toFixed(2)} does not match quantity × rate (${computed.toFixed(2)})`,
        severity: "error",
      });
    }

    // A deduction coded to an income statement account reduces reported
    // expense. Legitimate, but worth saying out loud (SPEC §8.3).
    if (computed?.isNegative() && account && /^[456]/.test(account.code)) {
      issues.push({
        column: "account",
        message: `A negative line on ${account.code} ${account.name} reduces reported expense. If this is recovering cash already advanced, code it to an advances account instead.`,
        severity: "notice",
      });
    }

    // --- date -------------------------------------------------------------
    const issueDate = parseSheetDate(value("workOrderDate"), options.dateFormat ?? "MDY");
    if (!issueDate) {
      issues.push({ column: "workOrderDate", message: "Date could not be read", severity: "error" });
    }

    // --- line number and grouping ----------------------------------------
    const lineNoText = text("lineNo");
    const lineNo = Number(lineNoText);
    if (!lineNoText || !Number.isInteger(lineNo) || lineNo < 1) {
      issues.push({ column: "lineNo", message: "Line No. must be a whole number of 1 or more", severity: "error" });
    }

    let groupKey: string | null = null;
    if (consultant && Number.isInteger(lineNo) && lineNo >= 1 && issueDate) {
      if (lineNo === 1) {
        groupKey = `${consultant.id}:${row.rowNumber}`;
        openGroup.set(consultant.id, groupKey);
      } else {
        groupKey = openGroup.get(consultant.id) ?? null;
        if (!groupKey) {
          issues.push({
            column: "lineNo",
            message: `Line ${lineNo} for ${consultant.name} has no line 1 before it — a continuation with nothing to continue`,
            severity: "error",
          });
        }
      }
    }

    const blocked = has(issues, "error");
    const line =
      !blocked && consultant && account && quantity && rate && computed && issueDate && groupKey
        ? {
            consultantId: consultant.id,
            consultantName: consultant.name,
            lineNo,
            description: text("description"),
            accountId: account.id,
            accountLabel: `${account.code} ${account.name}`,
            quantity,
            rate,
            amount: computed,
            issueDate,
            groupKey,
          }
        : null;

    if (line && !line.description) {
      issues.push({ column: "description", message: "No description", severity: "error" });
    }

    const finalLine = has(issues, "error") ? null : line;

    if (finalLine) {
      let group = groups.get(finalLine.groupKey);
      if (!group) {
        const owner = consultant!;
        group = {
          groupKey: finalLine.groupKey,
          consultantId: owner.id,
          consultantName: owner.name,
          currency: owner.defaultCurrency || company.baseCurrency,
          issueDate: finalLine.issueDate,
          dueDate: new Date(finalLine.issueDate.getTime() + owner.paymentTermsDays * 86_400_000),
          lines: [],
          total: money(0),
          issues: [],
        };
        groups.set(finalLine.groupKey, group);
      }

      group.lines.push({
        rowNumber: row.rowNumber,
        description: finalLine.description,
        quantity: finalLine.quantity,
        rate: finalLine.rate,
        amount: finalLine.amount,
        accountId: finalLine.accountId,
      });
      group.total = group.total.plus(finalLine.amount);
    }

    validated.push({ rowNumber: row.rowNumber, raw: row.raw, issues, line: finalLine });
  }

  // --- checks that can only be made once a whole run is known -------------
  const lineNumbersByGroup = new Map<string, number[]>();
  for (const row of validated) {
    if (!row.line) continue;
    const list = lineNumbersByGroup.get(row.line.groupKey) ?? [];
    list.push(row.line.lineNo);
    lineNumbersByGroup.set(row.line.groupKey, list);
  }

  for (const [groupKey, numbers] of lineNumbersByGroup) {
    const group = groups.get(groupKey);
    if (!group) continue;

    const seen = new Set<number>();
    for (const number of numbers) {
      if (seen.has(number)) {
        group.issues.push({
          column: "lineNo",
          message: `Line ${number} appears twice for ${group.consultantName}`,
          severity: "error",
        });
      }
      seen.add(number);
    }

    const sorted = [...numbers].sort((a, b) => a - b);
    const gaps = sorted.some((number, index) => number !== index + 1);
    if (gaps) {
      group.issues.push({
        column: "lineNo",
        message: `Line numbers for ${group.consultantName} are ${sorted.join(", ")} — the lines import in sheet order and are renumbered`,
        severity: "warning",
      });
    }

    if (group.total.lessThanOrEqualTo(0)) {
      group.issues.push({
        column: "row",
        message: `${group.consultantName}'s work order nets to ${group.total.toFixed(2)}. Deductions exceeding the work are not a payable.`,
        severity: "error",
      });
    }
  }

  // A group-level error blocks its own rows, and nothing else.
  const blockedGroups = new Set(
    [...groups.values()].filter((group) => has(group.issues, "error")).map((group) => group.groupKey),
  );
  for (const row of validated) {
    if (row.line && blockedGroups.has(row.line.groupKey)) {
      row.issues.push(...groups.get(row.line.groupKey)!.issues.filter((issue) => issue.severity === "error"));
      row.line = null;
    }
  }

  const workOrders = [...groups.values()].filter((group) => !blockedGroups.has(group.groupKey));

  return {
    rows: validated,
    workOrders,
    counts: {
      error: validated.filter((row) => has(row.issues, "error")).length,
      warning: validated.filter((row) => !has(row.issues, "error") && has(row.issues, "warning")).length,
      valid: validated.filter((row) => !has(row.issues, "error")).length,
    },
  };
}
