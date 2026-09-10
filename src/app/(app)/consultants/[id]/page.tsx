import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { ConsultantForm } from "../consultant-form";
import { PartyNotes } from "@/components/party-notes";
import { Alert, Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Consultant") };

/**
 * One consultant: the fields that describe them, and everything written down
 * about them.
 *
 * Both sections live here rather than beside the list, because editing somebody
 * on a screen showing everybody made it easy to type into the wrong row.
 *
 * Scoped to kind = CONSULTANT as well as to the company, so a regular vendor
 * cannot be read through this page — the sections guarding the two differ.
 */
export default async function ConsultantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
    note?: string;
    noteSaved?: string;
    noteError?: string;
  }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { id } = await params;
  const { saved, error, note, noteSaved, noteError } = await searchParams;

  const [consultant, expenseAccounts] = await Promise.all([
    prisma.vendor.findFirst({
      where: { id, kind: "CONSULTANT", ...scope.where },
      include: { user: { select: { email: true } } },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!consultant) notFound();

  return (
    <>
      <PageHeader
        title={consultant.name}
        description={`Consultant · ${consultant.defaultCurrency} · ${consultant.paymentTermsDays} day terms${
          consultant.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4">
        <Link href="/consultants">
          <Button variant="ghost">All consultants</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Main information
          </h2>
          <ConsultantForm
            editing={consultant}
            expenseAccounts={expenseAccounts}
            error={error}
          />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Notes
          </h2>
          <PartyNotes
            scope={scope}
            party={{ vendorId: consultant.id }}
            back={`/consultants/${consultant.id}`}
            openNoteId={note}
            saved={noteSaved === "1"}
            error={noteError}
          />
        </section>
      </div>
    </>
  );
}
