import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { listUserCompanies } from "@/lib/company-scope";
import { APP_NAME } from "@/lib/brand";
import { Landing } from "@/components/marketing/landing";

export const metadata: Metadata = {
  title: `${APP_NAME} — bookkeeping for growing businesses`,
  description:
    "Accurate, on-time bookkeeping for small businesses and entrepreneurs. Monthly bookkeeping, reconciliation, financial reporting and payroll support — on our own accounting system or the one you already use.",
};

/**
 * Two pages at one address.
 *
 * Signed in, this is the router it always was: consultants to the time clock,
 * everyone else to the dashboard. Signed out, it is the public landing page
 * rather than a bounce to /login — gamibook.com has to sell the product to
 * someone who has never seen it, and a login form sells nothing.
 *
 * Signing in is still one click away in the nav, and /login is untouched, so
 * every existing bookmark and redirect still lands where it did.
 */
export default async function Home() {
  const userId = await currentUserId();
  if (!userId) return <Landing />;

  const companies = await listUserCompanies(userId);
  if (companies.length === 0) redirect("/no-access");
  if (companies.every((c) => c.role === "CONSULTANT")) redirect("/time-clock");
  if (companies.every((c) => !c.setupCompletedAt)) redirect("/setup");

  redirect("/dashboard");
}
