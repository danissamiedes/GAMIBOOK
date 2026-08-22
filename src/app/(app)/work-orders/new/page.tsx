import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { approveWorkOrder, computeWorkOrderLine } from "@/lib/payables/work-orders";
import { parseMoney } from "@/lib/money";
import { isoDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("New work order") };

export default async function NewWorkOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });
  const [consultants, accounts] = await Promise.all([
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: {
        ...scope.where,
        isActive: true,
        // Deduction lines legitimately hit an asset account such as Advances
        // to Consultants, so this list is wider than "expenses" (SPEC §8.3).
        type: { in: ["EXPENSE", "ASSET"] },
      },
      orderBy: { code: "asc" },
    }),
  ]);

  if (consultants.length === 0) {
    return (
      <>
        <PageHeader title="New work order" />
        <EmptyState title="No consultants yet">Add a consultant before raising work orders.</EmptyState>
      </>
    );
  }

  async function create(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const alsoApprove = String(formData.get("intent")) === "approve";

    const vendorId = String(formData.get("vendorId") || "");
    const consultant = await prisma.vendor.findFirst({
      where: { id: vendorId, ...inner.where, kind: "CONSULTANT" },
    });
    if (!consultant) redirect("/work-orders/new?error=consultant");

    const issueDate = parseAccountingDate(String(formData.get("issueDate") || "")) ?? today();
    const dueDate =
      parseAccountingDate(String(formData.get("dueDate") || "")) ??
      new Date(issueDate.getTime() + consultant.paymentTermsDays * 86_400_000);
    const currency = String(formData.get("currency") || consultant.defaultCurrency).toUpperCase();
    const fxRate = parseMoney(String(formData.get("fxRate") || "1")) ?? 1;

    const lineCount = Number(formData.get("lineCount") || 0);
    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const description = String(formData.get(`line-${index}-description`) || "").trim();
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      const quantity = parseMoney(String(formData.get(`line-${index}-quantity`) || ""));
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      // A negative rate is a deduction and is legitimate; zero is not a line.
      if (!description || !accountId || !quantity || rate === null || rate.isZero()) continue;

      lines.push({
        lineNumber: lines.length + 1,
        description,
        quantity,
        rate,
        amount: computeWorkOrderLine({ quantity, rate }),
        accountId,
      });
    }
    if (lines.length === 0) redirect("/work-orders/new?error=lines");

    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: inner.companyId,
        vendorId: consultant.id,
        issueDate,
        dueDate,
        currency,
        fxRate,
        memo: String(formData.get("memo") || "").trim() || null,
        lines: { create: lines },
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "work_order.created",
      entityType: "WorkOrder",
      entityId: workOrder.id,
      summary: `Draft for ${consultant.name}`,
    });

    if (alsoApprove) {
      try {
        await approveWorkOrder({
          companyId: inner.companyId,
          workOrderId: workOrder.id,
          userId: inner.userId,
          role: inner.role,
        });
      } catch (thrown) {
        if (thrown instanceof PostingError) {
          redirect(`/work-orders/${workOrder.id}?error=${encodeURIComponent(thrown.message)}`);
        }
        throw thrown;
      }
    }

    redirect(`/work-orders/${workOrder.id}`);
  }

  return (
    <>
      <PageHeader
        title="New work order"
        description="Description, quantity and rate. A negative rate is a deduction — a cash advance being recovered."
      />
      {params.error === "lines" ? (
        <Alert tone="error">Add at least one line with a description, quantity and rate.</Alert>
      ) : null}

      <Card className="mt-4">
        <form action={create} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Consultant">
              <Select name="vendorId" defaultValue={consultants[0].id}>
                {consultants.map((consultant) => (
                  <option key={consultant.id} value={consultant.id}>
                    {consultant.name} ({consultant.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Work order date" hint="The A/P entry posts on this date.">
              <Input type="date" name="issueDate" defaultValue={isoDate(today())} />
            </Field>
            <Field label="Due date">
              <Input type="date" name="dueDate" />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={consultants[0].defaultCurrency}>
                {[...new Set([company.baseCurrency, ...consultants.map((c) => c.defaultCurrency)])].map(
                  (currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ),
                )}
              </Select>
            </Field>
          </div>

          <Field
            label={`Exchange rate (${company.baseCurrency} per unit)`}
            hint={`Leave at 1 when the work order is in ${company.baseCurrency}.`}
          >
            <Input name="fxRate" inputMode="decimal" defaultValue="1" className="max-w-xs" />
          </Field>

          <DocumentLineEditor
            accounts={accounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            accountLabel="Account"
            currency={consultants[0].defaultCurrency}
            defaultAccountId={consultants[0].defaultAccountId ?? accounts[0]?.id}
          />

          <Field label="Memo">
            <Input name="memo" />
          </Field>

          <div className="flex gap-2">
            <Button type="submit" name="intent" value="approve">
              Approve work order
            </Button>
            <Button type="submit" name="intent" value="draft" variant="secondary">
              Save as draft
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}
