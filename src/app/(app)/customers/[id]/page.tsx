import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { PartyNotes } from "@/components/party-notes";
import { Button, Card, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Customer") };

/**
 * One customer: who they are, and everything written down about them.
 *
 * The editable fields stay on the list screen, which is where they have always
 * been. This page exists because notes and their attachments need room a side
 * form does not have.
 */
export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ noteSaved?: string; noteError?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { id } = await params;
  const { noteSaved, noteError } = await searchParams;

  const customer = await prisma.customer.findFirst({ where: { id, ...scope.where } });
  if (!customer) notFound();

  return (
    <>
      <PageHeader
        title={customer.name}
        description={`Customer · ${customer.defaultCurrency} · ${customer.paymentTermsDays} day terms${
          customer.isActive ? "" : " · inactive"
        }`}
      />

      <div className="mb-4 flex gap-2">
        <Link href={`/customers?edit=${customer.id}`}>
          <Button variant="secondary">Edit details</Button>
        </Link>
        <Link href="/customers">
          <Button variant="ghost">All customers</Button>
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Details</h2>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-slate-500">Invoice emails</dt>
              <dd>{customer.emails.length > 0 ? customer.emails.join(", ") : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Billing address</dt>
              <dd className="whitespace-pre-wrap">{customer.billingAddress || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Overdue reminders</dt>
              <dd>{customer.sendEmails ? "On" : "Off for this customer"}</dd>
            </div>
            {customer.notes ? (
              <div>
                <dt className="text-xs text-slate-500">Standing note on the record</dt>
                <dd className="whitespace-pre-wrap">{customer.notes}</dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <PartyNotes
          scope={scope}
          party={{ customerId: customer.id }}
          back={`/customers/${customer.id}`}
          saved={noteSaved === "1"}
          error={noteError}
        />
      </div>
    </>
  );
}
