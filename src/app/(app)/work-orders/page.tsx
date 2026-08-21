import Link from "next/link";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { formatAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { money } from "@/lib/money";
import { redirect } from "next/navigation";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { PostingError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: "Work orders — Ledger" };

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  APPROVED: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  PARTIALLY_PAID: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  PAID: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  VOID: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export default async function WorkOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; consultant?: string; approved?: string; failed?: string }>;
}) {
  const scope = await sectionScope("CONSULTANTS");
  const params = await searchParams;

  /**
   * Bulk approve (SPEC §8.3): each document posts in its own transaction, so
   * one failing — a closed period, a missing account — reports that row and
   * leaves the rest alone.
   */
  async function approveSelected(formData: FormData) {
    "use server";
    const inner = await sectionScope("CONSULTANTS");
    const ids = formData.getAll("selected").map(String).filter(Boolean);
    if (ids.length === 0) redirect("/work-orders?status=DRAFT");
    if (ids.length > 500) {
      redirect("/work-orders?status=DRAFT&failed=Too%20many%20at%20once%20%E2%80%94%20cap%20is%20500");
    }

    let approved = 0;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await approveWorkOrder({
          companyId: inner.companyId,
          workOrderId: id,
          userId: inner.userId,
          role: inner.role,
        });
        approved += 1;
      } catch (error) {
        failures.push(error instanceof PostingError ? error.message : "Unexpected error");
      }
    }

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "work_order.bulk_approved",
      entityType: "WorkOrder",
      summary: `${approved} approved, ${failures.length} failed`,
    });

    redirect(
      `/work-orders?status=APPROVED&approved=${approved}${
        failures.length > 0 ? `&failed=${encodeURIComponent(failures.slice(0, 3).join("; "))}` : ""
      }`,
    );
  }

  const workOrders = await prisma.workOrder.findMany({
    where: {
      ...scope.where,
      ...(params.status && params.status !== "ALL"
        ? { status: params.status as "DRAFT" | "APPROVED" | "PARTIALLY_PAID" | "PAID" | "VOID" }
        : {}),
      ...(params.consultant ? { vendorId: params.consultant } : {}),
    },
    include: { vendor: { select: { id: true, name: true } }, lines: { select: { id: true } } },
    orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const now = today();

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <PageHeader title="Work orders" description="What consultants are owed, and for what." />
        <div className="flex gap-2">
          <Link href="/work-orders/send">
            <Button variant="secondary">Send in bulk</Button>
          </Link>
          <Link href="/work-orders/import">
            <Button variant="secondary">Import from spreadsheet</Button>
          </Link>
          <Link href="/work-orders/new">
            <Button>New work order</Button>
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {["ALL", "DRAFT", "APPROVED", "PARTIALLY_PAID", "PAID", "VOID"].map((value) => (
          <Link key={value} href={`/work-orders?status=${value}`}>
            <Button variant={(params.status ?? "ALL") === value ? "primary" : "secondary"}>
              {value.replace("_", " ").toLowerCase()}
            </Button>
          </Link>
        ))}
      </div>

      {params.approved ? (
        <Alert tone="success">{params.approved} work orders approved and posted.</Alert>
      ) : null}
      {params.failed ? <Alert tone="error">{decodeURIComponent(params.failed)}</Alert> : null}

      {workOrders.length === 0 ? (
        <EmptyState title="No work orders here yet" />
      ) : (
        <Card>
          <form action={approveSelected}>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2 w-8"></th>
                <th className="py-2">Number</th>
                <th className="py-2">Consultant</th>
                <th className="py-2">Date</th>
                <th className="py-2">Due</th>
                <th className="py-2">Lines</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Total</th>
                <th className="py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {workOrders.map((workOrder) => {
                const overdue =
                  workOrder.dueDate < now &&
                  money(workOrder.balanceDue).greaterThan(0) &&
                  ["APPROVED", "PARTIALLY_PAID"].includes(workOrder.status);
                return (
                  <tr key={workOrder.id} className="border-b border-slate-100 dark:border-slate-800/60">
                    <td className="py-2">
                      {workOrder.status === "DRAFT" ? (
                        <input type="checkbox" name="selected" value={workOrder.id} />
                      ) : null}
                    </td>
                    <td className="py-2 font-mono text-xs">
                      <Link className="underline" href={`/work-orders/${workOrder.id}`}>
                        {workOrder.workOrderNumber ?? "draft"}
                      </Link>
                    </td>
                    <td className="py-2">{workOrder.vendor.name}</td>
                    <td className="py-2">{formatAccountingDate(workOrder.issueDate)}</td>
                    <td className={`py-2 ${overdue ? "text-red-600 dark:text-red-400" : ""}`}>
                      {formatAccountingDate(workOrder.dueDate)}
                    </td>
                    <td className="py-2 text-slate-500">{workOrder.lines.length}</td>
                    <td className="py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                          STATUS_STYLES[workOrder.status]
                        }`}
                      >
                        {workOrder.status.replace("_", " ").toLowerCase()}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(money(workOrder.total).toFixed(2), workOrder.currency)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(money(workOrder.balanceDue).toFixed(2), workOrder.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

          {workOrders.some((workOrder) => workOrder.status === "DRAFT") ? (
            <div className="mt-4 flex items-center gap-3">
              <Button type="submit" variant="secondary">
                Approve selected
              </Button>
              <p className="text-xs text-slate-500">
                Each posts on its own work order date. One failing does not stop the others.
              </p>
            </div>
          ) : null}
          </form>
        </Card>
      )}
    </>
  );
}
