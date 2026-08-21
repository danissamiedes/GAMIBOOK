import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { CompanyAccessError, RoleError } from "@/lib/errors";

/**
 * The single data-access guard required by SPEC §3.
 *
 * Every query touching company data goes through here. It does two things and
 * they are both load-bearing:
 *
 *   1. Proves the user is a member of the company, on every call, from the
 *      database — never from the session, which the user can influence.
 *   2. Hands back a `where` fragment carrying the companyId, so callers filter
 *      server-side even when a request supplies its own document id.
 *
 * Hiding nav links is not access control. Neither is trusting the active
 * company held in the session.
 */

export type CompanyScope = {
  companyId: string;
  userId: string;
  role: Role;
  /** Spread into any Prisma `where` for a company-scoped model. */
  where: { companyId: string };
  /** Throws unless the caller holds one of `roles`. */
  requireRole: (...roles: Role[]) => void;
  /** True when the caller holds one of `roles`. */
  hasRole: (...roles: Role[]) => boolean;
};

/** Roles allowed to touch financial data at all (SPEC §2). */
export const FINANCIAL_ROLES: Role[] = ["OWNER", "BOOKKEEPER"];

export async function withCompanyScope(
  userId: string | undefined | null,
  companyId: string | undefined | null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<CompanyScope> {
  if (!userId) throw new CompanyAccessError("Not signed in");
  if (!companyId) throw new CompanyAccessError("No company selected");

  const membership = await client.membership.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true, user: { select: { isActive: true } } },
  });

  if (!membership) throw new CompanyAccessError();
  if (!membership.user.isActive) throw new CompanyAccessError("This account is disabled");

  const role = membership.role;

  return {
    companyId,
    userId,
    role,
    where: { companyId },
    hasRole: (...roles: Role[]) => roles.includes(role),
    requireRole: (...roles: Role[]) => {
      if (!roles.includes(role)) throw new RoleError();
    },
  };
}

/**
 * Scope for anything financial. A CONSULTANT reaching one of these is a bug or
 * an attack, and either way it throws before a query runs (SPEC §2).
 */
export async function withFinancialScope(
  userId: string | undefined | null,
  companyId: string | undefined | null,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<CompanyScope> {
  const scope = await withCompanyScope(userId, companyId, client);
  scope.requireRole(...FINANCIAL_ROLES);
  return scope;
}

/** Companies this user may switch between, for the top-bar switcher (SPEC §3). */
export async function listUserCompanies(userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { userId, user: { isActive: true } },
    select: {
      role: true,
      company: { select: { id: true, name: true, baseCurrency: true, setupCompletedAt: true } },
    },
    orderBy: { company: { name: "asc" } },
  });
  return memberships.map((m) => ({ ...m.company, role: m.role }));
}
