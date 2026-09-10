import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { VendorForm } from "../vendor-form";
import { Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("New vendor") };

export default async function NewVendorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { error } = await searchParams;

  const [company, expenseAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader title="New vendor" description="Saving opens their page, where notes live." />
      <div className="mb-4">
        <Link href="/vendors">
          <Button variant="ghost">All vendors</Button>
        </Link>
      </div>
      <div className="max-w-xl">
        <VendorForm
          editing={null}
          baseCurrency={company.baseCurrency}
          expenseAccounts={expenseAccounts}
          error={error}
        />
      </div>
    </>
  );
}
