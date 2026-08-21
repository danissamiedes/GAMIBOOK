import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { resolveActiveCompanyId } from "@/lib/active-company";
import type { Section } from "@prisma/client";
import { RoleError, SectionError } from "@/lib/errors";
import {
  withCompanyScope,
  withFinancialScope,
  withSectionScope,
  type CompanyScope,
} from "@/lib/company-scope";

/**
 * The three lines every accounting page and server action starts with, in one
 * place: who is signed in, which company is active, and may they touch money.
 */
export async function financialScope(): Promise<CompanyScope> {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  return withFinancialScope(userId, companyId);
}

/**
 * What every page and action in a section starts with (SPEC §2.1).
 *
 * The refusal itself comes from withSectionScope() in the data layer, which
 * throws — that is the guarantee, and it stays a throw for anything that is not
 * a page. Here the throw is turned into a plain "you do not have access to this
 * section" page, because a bookkeeper who clicks a stale bookmark deserves a
 * sentence, not a stack trace.
 */
export async function sectionScope(section: Section): Promise<CompanyScope> {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");

  try {
    return await withSectionScope(userId, companyId, section);
  } catch (error) {
    if (error instanceof SectionError || error instanceof RoleError) {
      redirect(`/no-access?section=${section}`);
    }
    throw error;
  }
}

export async function companyScope(): Promise<CompanyScope> {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  return withCompanyScope(userId, companyId);
}
