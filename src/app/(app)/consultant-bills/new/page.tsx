import Link from "next/link";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { Alert, Button, PageHeader } from "@/components/ui";
import { ExpenseForm } from "../../expenses/expense-form";
import { createConsultantBill } from "../../expenses/actions";

export const metadata = { title: pageTitle("Record a consultant bill") };

/** A consultant's reimbursement or agreed cost, on its own screen (SPEC §8.2). */
export default async function NewConsultantBillPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const [company, consultants, expenseAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, defaultCurrency: true },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Record a consultant bill"
        description="What a consultant is owed outside a work order — a reimbursement, an agreed cost."
      />
      <div className="mb-4">
        <Link href="/consultant-bills">
          <Button variant="ghost">All consultant bills</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      <ExpenseForm
        action={createConsultantBill}
        kind="BILL"
        editing={null}
        parties={consultants}
        partyLabel="Consultant"
        partyRequired
        expenseAccounts={expenseAccounts}
        paymentAccounts={[]}
        baseCurrency={company.baseCurrency}
        cancelHref="/consultant-bills"
        showFileLink={false}
      />
    </>
  );
}
