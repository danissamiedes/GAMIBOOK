import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { withCompanyScope, withFinancialScope, type CompanyScope } from "@/lib/company-scope";

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

export async function companyScope(): Promise<CompanyScope> {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  return withCompanyScope(userId, companyId);
}
