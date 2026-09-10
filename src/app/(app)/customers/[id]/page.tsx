import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { CustomerForm } from "../customer-form";
import { PartyNotes } from "@/components/party-notes";
import { Alert, Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Customer") };

/**
 * One customer: the fields that describe them, and everything written down
 * about them. Both live here rather than beside the list, because editing
 * somebody on a screen showing everybody made it easy to type into the wrong
 * row.
 */
export default async function CustomerPage({
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
  const scope = await sectionScope("SALES");
  const { id } = await params;
  const { saved, error, note, noteSaved, noteError } = await searchParams;

  const [customer, company] = await Promise.all([
    prisma.customer.findFirst({ where: { id, ...scope.where } }),
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
  ]);
  if (!customer) notFound();

  return (
    <>
      <PageHeader
        title={customer.name}
        description={`Customer · ${customer.defaultCurrency} · ${customer.paymentTermsDays} day terms${
          customer.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4">
        <Link href="/customers">
          <Button variant="ghost">All customers</Button>
        </Link>
      </div>

      {saved ? <Alert tone="success">Saved.</Alert> : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Main information
          </h2>
          <CustomerForm editing={customer} baseCurrency={company.baseCurrency} error={error} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Notes
          </h2>
          <PartyNotes
            scope={scope}
            party={{ customerId: customer.id }}
            back={`/customers/${customer.id}`}
            timeZone={company.operatingTimeZone}
            openNoteId={note}
            saved={noteSaved === "1"}
            error={noteError}
          />
        </section>
      </div>
    </>
  );
}
