import Link from "next/link";
import type { Section } from "@prisma/client";
import { SECTION_DESCRIPTIONS, SECTION_LABELS } from "@/lib/company-scope";
import { Alert, Card } from "@/components/ui";

export const metadata = { title: "No access — Ledger" };

export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const { section } = await searchParams;
  const known = section && section in SECTION_LABELS ? (section as Section) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4">
      <Card>
        {known ? (
          <>
            <Alert tone="warning">
              Your access does not include the <strong>{SECTION_LABELS[known]}</strong> section.
            </Alert>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
              That section covers {SECTION_DESCRIPTIONS[known].toLowerCase()}. An owner can grant it
              under Users.
            </p>
          </>
        ) : (
          <Alert tone="warning">
            Your account is not a member of any company yet, or the company you asked for is not
            one of yours. Ask an owner to invite you.
          </Alert>
        )}
        <p className="mt-4 text-sm">
          <Link className="underline" href="/dashboard">
            Back to the dashboard
          </Link>
        </p>
      </Card>
    </main>
  );
}
