import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * The active company lives in a cookie, not a URL param the user can edit
 * (SPEC §3) — but nothing trusts it. Every read re-checks membership against
 * the database, and every query still filters by companyId through
 * withCompanyScope(). The cookie only decides which company to *offer*.
 */
const COOKIE = "ledger.activeCompanyId";

export async function setActiveCompany(companyId: string): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveCompany(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/**
 * Resolve the company to work in: the cookie's, if the user is still a member
 * of it, otherwise their first company. Returns null when they have none.
 */
export async function resolveActiveCompanyId(userId: string): Promise<string | null> {
  const jar = await cookies();
  const requested = jar.get(COOKIE)?.value;

  if (requested) {
    const membership = await prisma.membership.findUnique({
      where: { userId_companyId: { userId, companyId: requested } },
      select: { companyId: true },
    });
    if (membership) return membership.companyId;
  }

  const first = await prisma.membership.findFirst({
    where: { userId },
    select: { companyId: true },
    orderBy: { company: { name: "asc" } },
  });
  return first?.companyId ?? null;
}
