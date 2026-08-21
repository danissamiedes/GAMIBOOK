import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { listUserCompanies } from "@/lib/company-scope";

/** Landing: consultants go to the time clock, everyone else to the dashboard. */
export default async function Home() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");

  const companies = await listUserCompanies(userId);
  if (companies.length === 0) redirect("/no-access");
  if (companies.every((c) => c.role === "CONSULTANT")) redirect("/time-clock");
  if (companies.every((c) => !c.setupCompletedAt)) redirect("/setup");

  redirect("/dashboard");
}
