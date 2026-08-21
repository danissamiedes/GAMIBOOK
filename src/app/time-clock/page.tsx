import { redirect } from "next/navigation";
import { currentUserId, signOut } from "@/lib/auth";
import { listUserCompanies } from "@/lib/company-scope";
import { Button, Card, EmptyState } from "@/components/ui";

export const metadata = { title: "Time clock — Ledger" };

/**
 * The only screen a CONSULTANT can reach (SPEC §2, §9). Phase 1 ships the
 * route and the guard; the clock itself is Phase 6.
 */
export default async function TimeClockPage() {
  const userId = await currentUserId();
  if (!userId) redirect("/login");

  const companies = await listUserCompanies(userId);
  const consultantCompanies = companies.filter((c) => c.role === "CONSULTANT");

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Time clock</h1>
        <form action={endSession}>
          <Button variant="ghost" type="submit">
            Sign out
          </Button>
        </form>
      </div>
      <Card>
        <EmptyState title="The clock arrives in Phase 6">
          Clock in and out, today&apos;s entries, this week&apos;s total and your last 30 days will
          live here — all shown in Philippine time.
        </EmptyState>
        {consultantCompanies.length > 0 ? (
          <p className="mt-4 text-xs text-slate-500">
            You are set up as a consultant at{" "}
            {consultantCompanies.map((c) => c.name).join(", ")}.
          </p>
        ) : null}
      </Card>
    </main>
  );
}
