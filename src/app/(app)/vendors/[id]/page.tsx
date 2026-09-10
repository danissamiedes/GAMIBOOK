import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { VendorForm } from "../vendor-form";
import { PartyNotes } from "@/components/party-notes";
import { Alert, Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Vendor") };

/**
 * One vendor: the fields that describe them, and everything written down about
 * them. Scoped to kind = REGULAR as well as to the company, so a consultant
 * cannot be read through this page — the sections guarding the two differ.
 */
export default async function VendorPage({
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
  const scope = await sectionScope("VENDORS");
  const { id } = await params;
  const { saved, error, note, noteSaved, noteError } = await searchParams;

  const [vendor, company, expenseAccounts] = await Promise.all([
    prisma.vendor.findFirst({ where: { id, kind: "REGULAR", ...scope.where } }),
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  if (!vendor) notFound();

  return (
    <>
      <PageHeader
        title={vendor.name}
        description={`Vendor · ${vendor.defaultCurrency} · ${vendor.paymentTermsDays} day terms${
          vendor.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4">
        <Link href="/vendors">
          <Button variant="ghost">All vendors</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Main information
          </h2>
          <VendorForm
            editing={vendor}
            baseCurrency={company.baseCurrency}
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
            party={{ vendorId: vendor.id }}
            back={`/vendors/${vendor.id}`}
            openNoteId={note}
            saved={noteSaved === "1"}
            error={noteError}
          />
        </section>
      </div>
    </>
  );
}
