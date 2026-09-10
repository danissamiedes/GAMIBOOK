import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { ConsultantForm } from "../consultant-form";
import { Button, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("New consultant") };

export default async function NewConsultantPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const { error } = await searchParams;

  const expenseAccounts = await prisma.account.findMany({
    where: { ...scope.where, isActive: true, type: "EXPENSE" },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  return (
    <>
      <PageHeader title="New consultant" description="Saving opens their page, where notes live." />
      <div className="mb-4">
        <Link href="/consultants">
          <Button variant="ghost">All consultants</Button>
        </Link>
      </div>
      <div className="max-w-xl">
        <ConsultantForm editing={null} expenseAccounts={expenseAccounts} error={error} />
      </div>
    </>
  );
}
