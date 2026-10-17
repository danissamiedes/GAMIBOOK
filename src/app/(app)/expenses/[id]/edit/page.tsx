import Link from "next/link";
import { notFound } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { Alert, Button, PageHeader } from "@/components/ui";
import { ExpenseForm } from "../../expense-form";
import { saveConsultantBill, saveVendorExpense } from "../../actions";

export const metadata = { title: pageTitle("Edit expense") };

/**
 * Correcting one expense, on the document's own screen (SPEC §8.2).
 *
 * Supplier bills and consultants' bills are one model under two sections, so
 * — as on the document page itself — the expense is found first and the
 * section checked against whose bill it turns out to be.
 *
 * An expense with a payment on it, or a voided one, is not editable at all;
 * the service refuses it too, and this is the refusal somebody can read.
 */
export default async function EditExpensePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await companyScope();
  const { id } = await params;
  const { error } = await searchParams;

  const expense = await prisma.expense.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: { select: { kind: true } },
      applications: { include: { billPayment: { select: { reversedAt: true } } } },
    },
  });
  if (!expense) notFound();

  const consultant = expense.vendor?.kind === "CONSULTANT";
  if (!scope.hasSection(consultant ? "CONSULTANTS" : "VENDORS")) notFound();

  const bill = expense.kind === "BILL";
  const document = `/expenses/${expense.id}`;
  const paid = expense.applications.some((row) => !row.billPayment.reversedAt);

  if (expense.status === "VOID" || paid) {
    return (
      <>
        <PageHeader title="This cannot be edited" description={expense.description} />
        <Alert tone="warning">
          {expense.status === "VOID"
            ? "A void expense cannot be edited. Record it again instead."
            : "This bill has payments applied. Reverse them first, then edit it."}
        </Alert>
        <p className="mt-4">
          <Link href={document} className="underline">
            Back to the document
          </Link>
        </p>
      </>
    );
  }

  const [company, parties, expenseAccounts, paymentAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { baseCurrency: true },
    }),
    prisma.vendor.findMany({
      where: {
        ...scope.where,
        kind: consultant ? "CONSULTANT" : "REGULAR",
        // An archived party still owns the bills it was on, so the one this
        // expense names stays in the list even if it is no longer active.
        OR: [{ isActive: true }, { id: expense.vendorId ?? "" }],
      },
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

  return (
    <>
      <PageHeader
        title={`Edit ${bill ? "bill" : "expense"}${expense.reference ? ` ${expense.reference}` : ""}`}
        description={expense.description}
      />
      <div className="mb-4">
        <Link href={document}>
          <Button variant="ghost">Back to the document</Button>
        </Link>
      </div>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <ExpenseForm
        action={consultant ? saveConsultantBill : saveVendorExpense}
        kind={expense.kind}
        editing={{
          id: expense.id,
          kind: expense.kind,
          date: expense.date,
          dueDate: expense.dueDate,
          vendorId: expense.vendorId,
          description: expense.description,
          reference: expense.reference,
          amount: expense.amount.toFixed(2),
          currency: expense.currency,
          fxRate: expense.fxRate.toString(),
          expenseAccountId: expense.expenseAccountId,
          paymentAccountId: expense.paymentAccountId,
          receiptUrl: expense.receiptUrl,
        }}
        parties={parties}
        partyLabel={consultant ? "Consultant" : "Vendor"}
        partyRequired={bill}
        expenseAccounts={expenseAccounts}
        paymentAccounts={paymentAccounts}
        baseCurrency={company.baseCurrency}
        cancelHref={document}
        showFileLink={!consultant}
      />
    </>
  );
}
