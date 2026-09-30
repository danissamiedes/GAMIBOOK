import type { AccountSubtype, AccountType } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CompanyScope } from "@/lib/company-scope";
import { writeAudit } from "@/lib/audit";
import { SUBTYPES_BY_TYPE } from "./accounts";

/**
 * Editing an account you added yourself (SPEC §4.1).
 *
 * Three fields are labels and change freely: the code, the name and the
 * description. Renaming "Teachers- Hoops" or renumbering it from 6400 to 5200
 * moves nothing in the ledger — every posting refers to the account by id, so
 * the figures are identical before and after. Only the sort order of the
 * reports changes, which is the point of renumbering.
 *
 * Two fields are not labels:
 *
 *   **Subtype** decides which section of the P&L or balance sheet the account
 *   lands in. Moving one from Expense to Cost of Sales is a legitimate and
 *   common correction — it is how gross margin gets fixed — but it restates
 *   every period the account has postings in. Allowed, and said out loud.
 *
 *   **Type** is the accounting equation itself. An account that has been
 *   posted to cannot change it: an expense reclassified as an asset silently
 *   rewrites every past P&L and balance sheet, and no amount of warning text
 *   makes that a thing to offer casually. Before anything is posted it is just
 *   a mistake to fix, so it is allowed then.
 *
 * System accounts are not editable at all. The app posts to them by key, and
 * their names and codes are what every other screen and report says.
 */

export type AccountEditProblem =
  | "notFound"
  | "system"
  | "code"
  | "name"
  | "duplicate"
  | "subtype"
  | "typeLocked";

export const ACCOUNT_EDIT_MESSAGES: Record<AccountEditProblem, string> = {
  notFound: "That account is no longer here.",
  system: "System accounts cannot be edited — the app posts to them by name.",
  code: "A code is required.",
  name: "A name is required.",
  duplicate: "Another account already uses that code.",
  subtype: "Pick a subtype that belongs to the account's type.",
  typeLocked:
    "This account already has postings, so its type cannot change — that would rewrite every report it appears in. Deactivate it and add a new one instead.",
};

export type AccountEditInput = {
  code: string;
  name: string;
  description?: string | null;
  type: AccountType;
  subtype: AccountSubtype;
};

export type AccountEditResult =
  | { ok: true; code: string; name: string; restatesReports: boolean }
  | { ok: false; problem: AccountEditProblem };

/** What the edit screen may offer, given what has already been posted. */
export async function editableFields(
  scope: CompanyScope,
  accountId: string,
): Promise<{ editable: boolean; typeLocked: boolean; postings: number } | null> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, ...scope.where },
    select: { id: true, isSystem: true, _count: { select: { lines: true } } },
  });
  if (!account) return null;
  return {
    editable: !account.isSystem,
    typeLocked: account._count.lines > 0,
    postings: account._count.lines,
  };
}

export async function updateAccount(
  scope: CompanyScope,
  accountId: string,
  input: AccountEditInput,
): Promise<AccountEditResult> {
  // companyId in the filter is what stops an id from another company working,
  // whatever the caller sends.
  const account = await prisma.account.findFirst({
    where: { id: accountId, ...scope.where },
    include: { _count: { select: { lines: true } } },
  });
  if (!account) return { ok: false, problem: "notFound" };
  if (account.isSystem) return { ok: false, problem: "system" };

  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) return { ok: false, problem: "code" };
  if (!name) return { ok: false, problem: "name" };

  const typeChanged = input.type !== account.type;
  if (typeChanged && account._count.lines > 0) {
    return { ok: false, problem: "typeLocked" };
  }
  if (!SUBTYPES_BY_TYPE[input.type]?.includes(input.subtype)) {
    return { ok: false, problem: "subtype" };
  }

  if (code !== account.code) {
    const clash = await prisma.account.findFirst({
      where: { ...scope.where, code, id: { not: account.id } },
      select: { id: true },
    });
    if (clash) return { ok: false, problem: "duplicate" };
  }

  const description = input.description?.trim() || null;
  // A subtype move re-files the account in the reports, so every period it has
  // postings in reads differently afterwards. Worth telling the person who
  // just did it rather than leaving them to notice.
  const restatesReports =
    (input.subtype !== account.subtype || typeChanged) && account._count.lines > 0;

  await prisma.account.update({
    where: { id: account.id },
    data: { code, name, description, type: input.type, subtype: input.subtype },
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: "account.updated",
    entityType: "Account",
    entityId: account.id,
    summary: `${account.code} ${account.name} → ${code} ${name}`,
    data: {
      from: {
        code: account.code,
        name: account.name,
        type: account.type,
        subtype: account.subtype,
        description: account.description,
      },
      to: { code, name, type: input.type, subtype: input.subtype, description },
      postings: account._count.lines,
    },
  });

  return { ok: true, code, name, restatesReports };
}
