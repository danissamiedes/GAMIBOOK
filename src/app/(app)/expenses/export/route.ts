import { sectionScope } from "@/lib/session-scope";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { buildExpensesWorkbook, expensesFilename } from "@/lib/exports/expenses-workbook";

/**
 * The direct expenses or bills list, as a spreadsheet.
 *
 * Scoped exactly like the screen it comes from: the VENDORS section, and
 * regular vendors only. A consultant's bill belongs to the Consultants section
 * and must not leave through here — an export is the easiest place to
 * accidentally widen access, because nobody sees the rows go by.
 */
export async function GET(request: Request) {
  const scope = await sectionScope("VENDORS");
  const kind = new URL(request.url).searchParams.get("tab") === "bill" ? "BILL" : "DIRECT";

  const [company, expenses] = await Promise.all([
    prisma.company.findFirstOrThrow({
      where: { id: scope.companyId },
      select: { name: true },
    }),
    prisma.expense.findMany({
      where: {
        ...scope.where,
        kind,
        OR: [{ vendorId: null }, { vendor: { kind: "REGULAR" } }],
      },
      include: { vendor: { select: { name: true } } },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  const bytes = await buildExpensesWorkbook({
    kind,
    companyName: company.name,
    rows: expenses.map((expense) => ({
      date: expense.date,
      reference: expense.reference,
      vendorName: expense.vendor?.name ?? null,
      description: expense.description,
      amount: expense.amount.toFixed(2),
      balanceDue: expense.balanceDue.toFixed(2),
      currency: expense.currency,
      receiptUrl: expense.receiptUrl,
    })),
  });

  await writeAudit({
    companyId: scope.companyId,
    userId: scope.userId,
    action: kind === "BILL" ? "bills.exported" : "expenses.exported",
    entityType: "Expense",
    summary: `${expenses.length} row${expenses.length === 1 ? "" : "s"}`,
  });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${expensesFilename(
        kind,
        company.name,
        new Date(),
      )}"`,
      "cache-control": "private, no-store",
    },
  });
}
