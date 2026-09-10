import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { CustomerForm } from "../customer-form";
import { Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("New customer") };

export default async function NewCustomerPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("SALES");
  const { error } = await searchParams;
  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });

  return (
    <>
      <PageHeader title="New customer" description="Saving opens their page, where notes live." />
      <div className="mb-4">
        <Link href="/customers">
          <Button variant="ghost">All customers</Button>
        </Link>
      </div>
      <div className="max-w-xl">
        <CustomerForm editing={null} baseCurrency={company.baseCurrency} error={error} />
      </div>
    </>
  );
}
