import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { failTo } from "@/lib/fail";
import { writeAudit } from "@/lib/audit";
import {
  cancelPurchaseOrder,
  deletePurchaseOrder,
  issuePurchaseOrder,
  receivePurchaseOrder,
  whyNotDeletablePurchaseOrder,
} from "@/lib/payables/purchase-orders";
import { preparePurchaseOrderEmail, sendEmail, stampEmailed } from "@/lib/email/send";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { formatMoney } from "@/lib/currency";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { Alert, Button, Card, DataTable, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: pageTitle("Purchase order") };

/**
 * One purchase order: what was ordered, who it went to, and what became of it
 * (SPEC §8.1a).
 *
 * Four things can happen here and they are the whole document's life: issue
 * it (number, sendable), email it, receive it (which makes the bill and is
 * the only step that reaches the ledger), or cancel it.
 */
export default async function PurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; sent?: string; receive?: string; delete?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  const { id } = await params;
  const query = await searchParams;

  const order = await prisma.purchaseOrder.findFirst({
    where: { id, ...scope.where },
    include: {
      vendor: true,
      lines: { orderBy: { lineNumber: "asc" } },
      expense: { select: { id: true, reference: true, date: true, balanceDue: true } },
    },
  });
  if (!order) notFound();

  const [company, accounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: { in: ["EXPENSE", "ASSET"] } },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  const back = `/purchase-orders/${order.id}`;
  const codedTo = [...new Set(order.lines.map((line) => line.expenseAccountId))];
  const accountName = (accountId: string) => {
    const account = accounts.find((row) => row.id === accountId);
    return account ? `${account.code} ${account.name}` : "—";
  };

  async function issue() {
    "use server";
    const inner = await sectionScope("VENDORS");
    try {
      const issued = await issuePurchaseOrder({ companyId: inner.companyId, purchaseOrderId: id });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "purchase_order.issued",
        entityType: "PurchaseOrder",
        entityId: id,
        summary: issued.orderNumber ?? "",
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(back);
  }

  async function email() {
    "use server";
    const inner = await sectionScope("VENDORS");
    let prepared;
    try {
      prepared = await preparePurchaseOrderEmail({
        companyId: inner.companyId,
        purchaseOrderId: id,
      });
    } catch (thrown) {
      // An unconfigured mailbox is an operator's setting, and its own message
      // names which one. It is not secret and it is not a crash.
      if (thrown instanceof ConfigurationError) failTo(back, thrown.message);
      throw thrown;
    }
    if (prepared.to.length === 0) {
      failTo(back, prepared.excludedReason ?? "This vendor has no email address on file");
    }
    const result = await sendEmail({
      companyId: inner.companyId,
      email: prepared,
      userId: inner.userId,
    });
    if (result.status === "SENT") {
      await stampEmailed("PurchaseOrder", id, inner.companyId);
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "purchase_order.emailed",
        entityType: "PurchaseOrder",
        entityId: id,
        summary: prepared.to.join(", "),
      });
    } else {
      failTo(back, result.error ?? "The email failed. See the email log.");
    }
    redirect(`${back}?sent=1`);
  }

  async function receive(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    try {
      const bill = await receivePurchaseOrder({
        companyId: inner.companyId,
        purchaseOrderId: id,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        reference: String(formData.get("reference") || "").trim(),
        expenseAccountId: String(formData.get("expenseAccountId") || "") || null,
        userId: inner.userId,
        role: inner.role,
      });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "purchase_order.received",
        entityType: "PurchaseOrder",
        entityId: id,
        summary: `Bill ${bill.reference ?? ""}`.trim(),
      });
      redirect(`/expenses/${bill.id}?saved=1`);
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(`${back}?receive=1`, thrown.message);
      throw thrown;
    }
  }

  async function cancel() {
    "use server";
    const inner = await sectionScope("VENDORS");
    try {
      await cancelPurchaseOrder({ companyId: inner.companyId, purchaseOrderId: id });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "purchase_order.cancelled",
        entityType: "PurchaseOrder",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect(back);
  }

  async function remove() {
    "use server";
    const inner = await sectionScope("VENDORS");
    try {
      await deletePurchaseOrder({ companyId: inner.companyId, purchaseOrderId: id });
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "purchase_order.deleted",
        entityType: "PurchaseOrder",
        entityId: id,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo(back, thrown.message);
      throw thrown;
    }
    redirect("/purchase-orders?deleted=1");
  }

  // Read once, above the markup: the clock is not something to call while
  // rendering (the purity rule), and the due date is derived from it.
  const now = today();
  const defaultDueDate = isoDate(
    new Date(now.getTime() + order.vendor.paymentTermsDays * 86_400_000),
  );

  const draft = order.status === "DRAFT";
  const issued = order.status === "ISSUED";
  const deletable = whyNotDeletablePurchaseOrder(order) === null && draft;

  return (
    <>
      <PageHeader
        title={`Purchase order ${order.orderNumber ?? "(draft)"}`}
        description={`${order.vendor.name} · ${formatAccountingDate(order.orderDate)} · ${formatMoney(
          order.total.toFixed(2),
          order.currency,
        )}`}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/purchase-orders">
          <Button variant="ghost">All purchase orders</Button>
        </Link>
        <Link href={`/vendors/${order.vendorId}`}>
          <Button variant="ghost">{order.vendor.name}</Button>
        </Link>
        <a href={`/documents/purchase-order/${order.id}`} target="_blank" rel="noreferrer">
          <Button variant="ghost">PDF</Button>
        </a>

        <span className="ml-auto flex flex-wrap gap-2">
          {draft ? (
            <>
              <form action={issue}>
                <Button type="submit">Issue</Button>
              </form>
              {deletable ? (
                <form action={remove}>
                  <Button type="submit" variant="ghost">
                    Delete draft
                  </Button>
                </form>
              ) : null}
            </>
          ) : null}
          {issued ? (
            <>
              <form action={email}>
                <Button type="submit" variant="secondary">
                  {order.lastEmailedAt ? "Email again" : "Email to vendor"}
                </Button>
              </form>
              <Link href={`${back}?receive=1`}>
                <Button>Receive — make the bill</Button>
              </Link>
            </>
          ) : null}
          {draft || issued ? (
            <form action={cancel}>
              <Button type="submit" variant="ghost">
                Cancel order
              </Button>
            </form>
          ) : null}
        </span>
      </div>

      {query.error ? <Alert tone="error">{query.error}</Alert> : null}
      {query.sent ? (
        <Alert tone="success">Emailed to {order.vendor.email}. The PDF went with it.</Alert>
      ) : null}
      {order.status === "RECEIVED" && order.expense ? (
        <Alert tone="success">
          Received. This became{" "}
          <Link href={`/expenses/${order.expense.id}`} className="underline">
            bill {order.expense.reference ?? "(no reference)"}
          </Link>{" "}
          on {formatAccountingDate(order.expense.date)} — that is what is in the ledger.
        </Alert>
      ) : null}
      {order.status === "CANCELLED" ? (
        <Alert tone="warning">
          Cancelled{order.cancelledAt ? ` on ${formatAccountingDate(order.cancelledAt)}` : ""}.
          Nothing was posted for it, so there is nothing to reverse.
        </Alert>
      ) : null}
      {draft ? (
        <Alert tone="info">
          A draft has no number and cannot be sent. Issuing it gives it one — and still posts
          nothing.
        </Alert>
      ) : null}

      {query.receive === "1" && issued ? (
        <Card className="my-4">
          <h2 className="mb-2 text-sm font-semibold">The goods arrived — make the bill</h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            This records a bill against {order.vendor.name} for{" "}
            {formatMoney(order.total.toFixed(2), order.currency)}, which is the posting this
            order has been waiting for. The order and the bill will point at each other.
          </p>
          <form action={receive} className="grid gap-3 sm:grid-cols-4">
            <Field label="Bill date">
              <Input type="date" name="date" defaultValue={isoDate(now)} />
            </Field>
            <Field label="Due date">
              <Input
                type="date"
                name="dueDate"
                defaultValue={defaultDueDate}
              />
            </Field>
            <Field label="Vendor's invoice no." hint="Required — it is the bill's reference.">
              <Input name="reference" required />
            </Field>
            {codedTo.length > 1 ? (
              <Field label="Code the bill to" hint="This order's lines use more than one account.">
                <Select name="expenseAccountId" defaultValue={codedTo[0]} required>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Field label="Coded to">
                <Input value={accountName(codedTo[0] ?? "")} readOnly />
              </Field>
            )}
            <div className="sm:col-span-4 flex gap-2">
              <Button type="submit">Record the bill</Button>
              <Link
                href={back}
                className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                Cancel
              </Link>
            </div>
          </form>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">What was ordered</h2>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Description</th>
                <th className="py-2">Code to</th>
                <th className="py-2 text-right">Qty</th>
                <th className="py-2 text-right">Price</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((line) => (
                <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{line.description}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {accountName(line.expenseAccountId)}
                  </td>
                  <td className="py-2 text-right tabular-nums">{line.quantity.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">{line.rate.toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(line.amount.toFixed(2), order.currency)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="py-2 font-semibold" colSpan={4}>
                  Total
                </td>
                <td className="py-2 text-right font-semibold tabular-nums">
                  {formatMoney(order.total.toFixed(2), order.currency)}
                </td>
              </tr>
            </tbody>
          </DataTable>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">The order</h2>
          <dl className="space-y-2 text-sm">
            <Row term="Number" value={order.orderNumber ?? "not issued yet"} />
            <Row term="Status" value={order.status.toLowerCase()} />
            <Row term="Ordered" value={formatAccountingDate(order.orderDate)} />
            <Row
              term="Wanted by"
              value={order.expectedDate ? formatAccountingDate(order.expectedDate) : "—"}
            />
            <Row term="Vendor" value={order.vendor.name} />
            <Row term="Deliver to" value={order.shipTo ?? "—"} />
            <Row term="Memo" value={order.memo ?? "—"} />
            <Row
              term="Currency"
              value={
                order.currency === company.baseCurrency
                  ? order.currency
                  : `${order.currency} at ${order.fxRate.toString()}`
              }
            />
            <Row
              term="Emailed"
              value={order.lastEmailedAt ? formatAccountingDate(order.lastEmailedAt) : "not yet"}
            />
          </dl>
          <p className="mt-4 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-800">
            A purchase order is a commitment, not an entry: nothing here is in the ledger until
            the bill is made from it.
          </p>
        </Card>
      </div>
    </>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-slate-500">{term}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
