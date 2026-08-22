import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { updateWorkOrder } from "@/lib/payables/work-orders";
import { parseMoney } from "@/lib/money";
import { isoDate, parseAccountingDate } from "@/lib/dates";
import { PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import { DocumentLineEditor } from "@/components/document-line-editor";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Edit work order") };

/**
 * Editing a work order (SPEC §8.1, mirroring §7.1). Draft changes outright,
 * approved reverses and reposts, keeping the number.
 */
export default async function EditWorkOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const scope = await sectionScope("CONSULTANTS");
  const { error } = await searchParams;

  const [company, workOrder, consultants, accounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.workOrder.findFirst({
      where: { id, ...scope.where },
      include: {
        lines: { orderBy: { lineNumber: "asc" } },
        applications: { include: { billPayment: { select: { reversedAt: true } } } },
      },
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "CONSULTANT", isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: { in: ["EXPENSE", "ASSET"] } },
      orderBy: { code: "asc" },
    }),
  ]);

  if (!workOrder) notFound();

  const paid = workOrder.applications.filter((a) => !a.billPayment.reversedAt).length > 0;
  const posted = workOrder.status !== "DRAFT";

  if (workOrder.status === "VOID" || paid) {
    return (
      <>
        <PageHeader title={`Work order ${workOrder.workOrderNumber ?? "draft"}`} />
        <Alert tone="error">
          {workOrder.status === "VOID"
            ? "A void work order cannot be edited. Raise a new one instead."
            : "This work order has payments applied. Reverse them first, then edit it."}
        </Alert>
        <div className="mt-4">
          <Link className="underline" href={`/work-orders/${workOrder.id}`}>
            Back to the work order
          </Link>
        </div>
      </>
    );
  }

  async function save(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const back = `/work-orders/${id}/edit`;

    const lineCount = Number(formData.get("lineCount") || 0);
    const lines = [];
    for (let index = 0; index < lineCount; index++) {
      const description = String(formData.get(`line-${index}-description`) || "").trim();
      const accountId = String(formData.get(`line-${index}-accountId`) || "");
      const quantity = parseMoney(String(formData.get(`line-${index}-quantity`) || ""));
      const rate = parseMoney(String(formData.get(`line-${index}-rate`) || ""));
      // A negative rate is a deduction and is legitimate; zero is not a line.
      if (!description || !accountId || !quantity || rate === null || rate.isZero()) continue;
      lines.push({ description, quantity, rate, accountId });
    }
    if (lines.length === 0) failTo(back, "Add at least one line with a description, quantity and rate.");

    try {
      await updateWorkOrder({
        companyId: inner.companyId,
        workOrderId: id,
        vendorId: String(formData.get("vendorId") || "") || undefined,
        issueDate: parseAccountingDate(String(formData.get("issueDate") || "")) ?? undefined,
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")) ?? undefined,
        currency: String(formData.get("currency") || "").toUpperCase() || undefined,
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? undefined,
        memo: String(formData.get("memo") || "").trim() || null,
        lines,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "work_order.updated",
        entityType: "WorkOrder",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }

    redirect(`/work-orders/${id}?saved=1`);
  }

  return (
    <>
      <PageHeader
        title={`Edit work order ${workOrder.workOrderNumber ?? "draft"}`}
        description={
          posted
            ? "This work order has posted. Saving reverses that entry and posts the corrected one; it keeps its number."
            : "A draft posts nothing, so this simply changes it."
        }
      />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {posted ? (
        <Alert tone="warning">
          The reversal is dated to the original posting, so the month this work
          order belongs to stays right. If that month is closed, only an owner
          can save.
        </Alert>
      ) : null}

      <Card className="mt-4">
        <form action={save} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Consultant">
              <Select name="vendorId" defaultValue={workOrder.vendorId}>
                {consultants.map((consultant) => (
                  <option key={consultant.id} value={consultant.id}>
                    {consultant.name} ({consultant.defaultCurrency})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Work order date">
              <Input
                type="date"
                name="issueDate"
                defaultValue={isoDate(workOrder.issueDate)}
              />
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                name="dueDate"
                defaultValue={isoDate(workOrder.dueDate)}
              />
            </Field>
            <Field label="Currency">
              <Select name="currency" defaultValue={workOrder.currency}>
                {[
                  ...new Set([
                    company.baseCurrency,
                    workOrder.currency,
                    ...consultants.map((c) => c.defaultCurrency),
                  ]),
                ].map((currency) => (
                  <option key={currency} value={currency}>
                    {currency}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
            <Input
              name="fxRate"
              inputMode="decimal"
              defaultValue={workOrder.fxRate.toString()}
              className="max-w-xs"
            />
          </Field>

          <DocumentLineEditor
            accounts={accounts.map((account) => ({
              id: account.id,
              code: account.code,
              name: account.name,
            }))}
            accountLabel="Account"
            currency={workOrder.currency}
            defaultAccountId={accounts[0]?.id}
            initialLines={workOrder.lines.map((line) => ({
              itemId: "",
              description: line.description,
              quantity: line.quantity.toString(),
              rate: line.rate.toString(),
              accountId: line.accountId,
            }))}
          />

          <Field label="Memo">
            <Input name="memo" defaultValue={workOrder.memo ?? ""} />
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit">Save changes</Button>
            <Link
              href={`/work-orders/${workOrder.id}`}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </Link>
          </div>
        </form>
      </Card>
    </>
  );
}
