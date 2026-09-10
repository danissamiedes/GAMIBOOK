import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { PartyNotes } from "@/components/party-notes";
import { Button, Card, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Consultant") };

/**
 * One consultant: who they are, and everything written down about them.
 *
 * The editable fields stay on the list screen. This page exists because notes
 * and their attachments need room a side form does not have.
 *
 * Scoped to CONSULTANT, so the two kinds of Vendor cannot be read through each
 * other's page — the sections that guard them are different.
 */
export default async function ConsultantPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ noteSaved?: string; noteError?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { id } = await params;
  const { noteSaved, noteError } = await searchParams;

  const party = await prisma.vendor.findFirst({
    where: { id, kind: "CONSULTANT", ...scope.where },
  });
  if (!party) notFound();

  return (
    <>
      <PageHeader
        title={party.name}
        description={`Consultant · ${party.defaultCurrency} · ${party.paymentTermsDays} day terms${
          party.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4 flex gap-2">
        <Link href={`/consultants?edit=${party.id}`}>
          <Button variant="secondary">Edit details</Button>
        </Link>
        <Link href="/consultants">
          <Button variant="ghost">All consultants</Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Details</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Email</dt>
              <dd>{party.email || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Address</dt>
              <dd className="whitespace-pre-wrap">{party.address || "—"}</dd>
            </div>
            {party.notes ? (
              <div>
                <dt className="text-xs text-slate-500">Standing note on the record</dt>
                <dd className="whitespace-pre-wrap">{party.notes}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <PartyNotes
          scope={scope}
          party={{ vendorId: party.id }}
          back={`/consultants/${party.id}`}
          saved={noteSaved === "1"}
          error={noteError}
        />
      </div>
    </>
  );
}
