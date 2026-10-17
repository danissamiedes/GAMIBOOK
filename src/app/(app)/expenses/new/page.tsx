import Link from "next/link";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { Alert, Button, PageHeader } from "@/components/ui";
import { ExpenseForm } from "../expense-form";
import { createDirectExpense, createVendorBill } from "../actions";

export const metadata = { title: pageTitle("Record an expense") };

/**
 * Recording a direct expense or a bill, on a screen of its own (SPEC §8.2).
 *
 * Two kinds, one form, chosen by the tab that was clicked — not a toggle
 * inside the form, which is how a bill gets recorded as already paid.
 */
export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; error?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const params = await searchParams;
  const bill = params.tab === "bill";

  const [company, vendors, expenseAccounts, paymentAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, defaultCurrency: true },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const back = `/expenses?tab=${bill ? "bill" : "direct"}`;

  return (
    <>
      <PageHeader
        title={bill ? "Record a bill" : "Record a direct expense"}
        description={
          bill
            ? "Owed now, paid later. It sits in accounts payable until it is settled."
            : "Paid as you record it, straight out of the account you name."
        }
      />
      <div className="mb-4">
        <Link href={back}>
          <Button variant="ghost">All expenses</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}

      <ExpenseForm
        action={bill ? createVendorBill : createDirectExpense}
        kind={bill ? "BILL" : "DIRECT"}
        editing={null}
        parties={vendors}
        partyLabel="Vendor"
        partyRequired={bill}
        expenseAccounts={expenseAccounts}
        paymentAccounts={paymentAccounts}
        baseCurrency={company.baseCurrency}
        cancelHref={back}
      />
    </>
  );
}
