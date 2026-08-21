import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";
import { DEFAULT_CHART_OF_ACCOUNTS, type SystemAccountKey } from "./accounts";

/** Give a new company the default chart of accounts (SPEC Phase 2). */
export async function createDefaultChartOfAccounts(
  companyId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const existing = await client.account.count({ where: { companyId } });
  if (existing > 0) return { created: 0 };

  await client.account.createMany({
    data: DEFAULT_CHART_OF_ACCOUNTS.map((account) => ({
      companyId,
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype,
      systemKey: account.systemKey ?? null,
      isSystem: Boolean(account.systemKey),
      description: account.description ?? null,
    })),
  });

  return { created: DEFAULT_CHART_OF_ACCOUNTS.length };
}

/** Find a system account by key. Throws rather than posting to the wrong place. */
export async function systemAccount(
  companyId: string,
  key: SystemAccountKey,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const account = await client.account.findFirst({ where: { companyId, systemKey: key } });
  if (!account) {
    throw new PostingError(`This company has no ${key} account. Re-run chart of accounts setup.`);
  }
  return account;
}

/**
 * Deactivate an account. Never a hard delete once it has postings (SPEC §13);
 * an account with no postings at all may be removed outright.
 */
export async function deactivateAccount(companyId: string, accountId: string) {
  const account = await prisma.account.findFirst({ where: { id: accountId, companyId } });
  if (!account) throw new PostingError("Account not found in this company");
  if (account.isSystem) throw new PostingError("System accounts cannot be deactivated");

  const postings = await prisma.journalLine.count({ where: { accountId } });
  if (postings === 0) {
    const children = await prisma.account.count({ where: { parentId: accountId } });
    if (children === 0) {
      await prisma.account.delete({ where: { id: accountId } });
      return { deleted: true };
    }
  }

  await prisma.account.update({ where: { id: accountId }, data: { isActive: false } });
  return { deleted: false };
}
