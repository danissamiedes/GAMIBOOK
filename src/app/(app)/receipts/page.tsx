import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { readerConfigured } from "@/lib/receipts/extract";
import {
  approveReceipt,
  dismissReceipt,
  extractReceipt,
  restoreReceipt,
  uploadReceipt,
} from "@/lib/receipts/service";
import { dismissInboxMessage, restoreInboxMessage } from "@/lib/receipts/inbox";
import { money, parseMoney } from "@/lib/money";
import { formatMoney, SUPPORTED_CURRENCIES } from "@/lib/currency";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { ConfigurationError, PostingError } from "@/lib/errors";
import { failTo } from "@/lib/fail";
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
} from "@/components/ui";

export const metadata = { title: pageTitle("Receipt inbox") };

/**
 * Photographs of receipts, waiting to become expenses (SPEC §8.2 extension).
 *
 * Nothing on this screen is in the books. A row here is a picture and a
 * suggestion; approving it is what records an expense and posts it. That
 * separation is the point — a reader that misreads 1,780 as 1,180 costs
 * somebody a correction, not a wrong set of accounts.
 */
export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    saved?: string;
    show?: string;
    open?: string;
    tab?: string;
  }>;
}) {
  const scope = await sectionScope("VENDORS");
  // The nav hides this from a bookkeeper; this is what actually stops them.
  // A typed URL has to hit the same wall a missing link implies.
  scope.requireRole("OWNER");
  const params = await searchParams;
  const showDismissed = params.show === "dismissed";
  // Two ways paperwork arrives — photographed, or forwarded by email — and
  // they are different enough to deserve their own list rather than one
  // mixed queue sorted by an accident of how it got here.
  const tab = params.tab === "email" ? "email" : "photos";

  const [company, receipts, vendors, expenseAccounts, paymentAccounts] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    prisma.receiptUpload.findMany({
      where: {
        ...scope.where,
        status: showDismissed ? "DISMISSED" : { in: ["PENDING", "READY"] },
      },
      include: { uploadedBy: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.vendor.findMany({
      where: { ...scope.where, kind: "REGULAR", isActive: true },
      orderBy: { name: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, type: "EXPENSE" },
      orderBy: { code: "asc" },
    }),
    prisma.account.findMany({
      where: { ...scope.where, isActive: true, subtype: { in: ["CASH", "CREDIT_CARD"] } },
      orderBy: { code: "asc" },
    }),
  ]);

  const [forwarded, waitingByEmail] = await Promise.all([
    prisma.inboxMessage.findMany({
      where: {
        ...scope.where,
        status: showDismissed ? "DISMISSED" : { in: ["WAITING", "RECORDED"] },
      },
      include: {
        attachments: { orderBy: { createdAt: "asc" } },
        expense: { select: { id: true, kind: true, reference: true, description: true } },
      },
      orderBy: { receivedAt: "desc" },
      take: 100,
    }),
    prisma.inboxMessage.count({ where: { ...scope.where, status: "WAITING" } }),
  ]);

  const open = params.open ? (receipts.find((r) => r.id === params.open) ?? null) : null;
  const reads = readerConfigured();
  // Only worth mentioning when reading is on and a photo slipped through
  // unread; with reading off, every photo is "unread" and saying so is noise.
  const pendingCount = reads
    ? receipts.filter((receipt) => receipt.status === "PENDING").length
    : 0;

  async function upload(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const files = formData.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length === 0) failTo("/receipts", "Choose at least one photo");

    let read = 0;
    for (const file of files) {
      try {
        const receipt = await uploadReceipt({
          companyId: inner.companyId,
          userId: inner.userId,
          filename: file.name,
          mimeType: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        });
        // Read straight away so the queue is useful on arrival. A reader that
        // is not configured must not lose the upload, so this is best-effort.
        try {
          await extractReceipt(inner.companyId, receipt.id);
          read += 1;
        } catch {
          // Left as PENDING; the row offers a Read button.
        }
      } catch (thrown) {
        if (thrown instanceof PostingError || thrown instanceof ConfigurationError) {
          failTo("/receipts", thrown.message);
        }
        throw thrown;
      }
    }

    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "receipt.uploaded",
      entityType: "ReceiptUpload",
      summary: `${files.length} photo${files.length === 1 ? "" : "s"}, ${read} read`,
    });
    redirect("/receipts?saved=1");
  }

  async function read(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("receiptId") || "");
    try {
      await extractReceipt(inner.companyId, id);
    } catch (thrown) {
      if (thrown instanceof PostingError || thrown instanceof ConfigurationError) {
        failTo("/receipts", thrown.message);
      }
      throw thrown;
    }
    redirect(`/receipts?open=${id}`);
  }

  async function approve(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("receiptId") || "");
    const back = `/receipts?open=${id}`;
    const kind = String(formData.get("kind")) === "BILL" ? "BILL" : "DIRECT";
    const amount = parseMoney(String(formData.get("amount") || ""));
    if (!amount) failTo(back, "Enter the amount");
    const description = String(formData.get("description") || "").trim();
    if (!description) failTo(back, "Enter a description");

    try {
      await approveReceipt({
        companyId: inner.companyId,
        receiptId: id,
        kind,
        date: parseAccountingDate(String(formData.get("date") || "")) ?? today(),
        amount: amount!,
        currency: String(formData.get("currency") || "").toUpperCase(),
        fxRate: parseMoney(String(formData.get("fxRate") || "1")) ?? 1,
        description,
        expenseAccountId: String(formData.get("expenseAccountId")),
        paymentAccountId: kind === "DIRECT" ? String(formData.get("paymentAccountId")) : null,
        vendorId: String(formData.get("vendorId") || "") || null,
        dueDate: parseAccountingDate(String(formData.get("dueDate") || "")),
        reference: String(formData.get("reference") || "").trim() || null,
        fileUrl: String(formData.get("fileUrl") || "").trim() || null,
        userId: inner.userId,
        role: inner.role,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError || thrown instanceof ConfigurationError) {
        failTo(back, thrown.message);
      }
      throw thrown;
    }
    redirect("/receipts?saved=1");
  }

  async function dismiss(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    const id = String(formData.get("receiptId") || "");
    try {
      await dismissReceipt({
        companyId: inner.companyId,
        receiptId: id,
        reason: String(formData.get("reason") || "").trim() || null,
        userId: inner.userId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo("/receipts", thrown.message);
      throw thrown;
    }
    redirect("/receipts");
  }

  async function dismissForwarded(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    inner.requireRole("OWNER");
    try {
      await dismissInboxMessage({
        companyId: inner.companyId,
        messageId: String(formData.get("messageId") || ""),
        reason: String(formData.get("reason") || ""),
        userId: inner.userId,
      });
    } catch (thrown) {
      if (thrown instanceof PostingError) failTo("/receipts?tab=email", thrown.message);
      throw thrown;
    }
    redirect("/receipts?tab=email");
  }

  async function restoreForwarded(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    inner.requireRole("OWNER");
    await restoreInboxMessage(inner.companyId, String(formData.get("messageId") || ""));
    redirect("/receipts?tab=email&show=dismissed");
  }

  async function restore(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    await restoreReceipt(inner.companyId, String(formData.get("receiptId") || ""));
    redirect("/receipts");
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <PageHeader
          title="Receipt inbox"
          description="Paperwork waiting to be entered — photographed here, or forwarded by email. Nothing is in the books until you record it."
        />
        <Link href="/receipts/settings">
          <Button variant="secondary">Bills by email</Button>
        </Link>
      </div>

      <div className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {[
          { key: "photos", label: "Photos", href: "/receipts" },
          {
            key: "email",
            label: `Forwarded by email${waitingByEmail > 0 ? ` (${waitingByEmail})` : ""}`,
            href: "/receipts?tab=email",
          },
        ].map((entry) => (
          <Link
            key={entry.key}
            href={entry.href}
            aria-current={tab === entry.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              tab === entry.key
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            }`}
          >
            {entry.label}
          </Link>
        ))}
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Done.</Alert> : null}
      {tab === "photos" && pendingCount > 0 ? (
        <Alert tone="info">
          {pendingCount} photo{pendingCount === 1 ? " has" : "s have"} not been read yet — use
          Read on the row, or fill the fields in by hand.
        </Alert>
      ) : null}

      {tab === "email" ? (
        <ForwardedList
          rows={forwarded}
          showDismissed={showDismissed}
          inboxAddress={company.inboxAddress}
          dismiss={dismissForwarded}
          restore={restoreForwarded}
        />
      ) : (
      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">
              {showDismissed ? "Dismissed" : "Waiting"}
            </h2>
            <Link
              className="text-xs underline"
              href={showDismissed ? "/receipts" : "/receipts?show=dismissed"}
            >
              {showDismissed ? "Back to the queue" : "Show dismissed"}
            </Link>
          </div>

          {receipts.length === 0 ? (
            <EmptyState title={showDismissed ? "Nothing dismissed" : "Nothing waiting"}>
              {showDismissed
                ? "Receipts you set aside show up here, and can be put back."
                : "Add photos on the right. Each one is read for its date, total and description, then waits for you to approve it."}
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {receipts.map((receipt) => {
                const isOpen = open?.id === receipt.id;
                const lowConfidence =
                  receipt.readConfidence !== null && money(receipt.readConfidence).lessThan("0.6");
                return (
                  <li
                    key={receipt.id}
                    className="rounded-lg border border-slate-200 dark:border-slate-800"
                  >
                    <div className="flex items-center gap-3 p-3">
                      <Link
                        href={`/receipts/${receipt.id}/image`}
                        target="_blank"
                        className="shrink-0 text-xs underline"
                      >
                        View
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {receipt.readDescription ?? receipt.filename}
                        </div>
                        <div className="text-xs text-slate-500">
                          {reads || receipt.readAt ? (
                            <>
                              {receipt.readDate
                                ? formatAccountingDate(receipt.readDate)
                                : "date not read"}
                              {" · "}
                              {receipt.readAmount
                                ? formatMoney(
                                    money(receipt.readAmount).toFixed(2),
                                    receipt.readCurrency ?? company.baseCurrency,
                                  )
                                : "amount not read"}
                              {receipt.readVendorName ? ` · ${receipt.readVendorName}` : ""}
                            </>
                          ) : (
                            <>
                              added {formatAccountingDate(receipt.createdAt)}
                              {receipt.uploadedBy?.name ? ` by ${receipt.uploadedBy.name}` : ""}
                            </>
                          )}
                        </div>
                        {receipt.readError ? (
                          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                            {receipt.readError}
                          </div>
                        ) : null}
                        {lowConfidence && !receipt.readError ? (
                          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                            Read with low confidence — check every figure.
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {showDismissed ? (
                          <form action={restore}>
                            <input type="hidden" name="receiptId" value={receipt.id} />
                            <Button variant="ghost" type="submit">
                              Put back
                            </Button>
                          </form>
                        ) : (
                          <>
                            {reads && receipt.status === "PENDING" ? (
                              <form action={read}>
                                <input type="hidden" name="receiptId" value={receipt.id} />
                                <Button variant="ghost" type="submit">
                                  Read
                                </Button>
                              </form>
                            ) : null}
                            <Link
                              href={isOpen ? "/receipts" : `/receipts?open=${receipt.id}`}
                              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-brand-50 hover:text-brand-700 dark:text-slate-300 dark:hover:bg-slate-800"
                            >
                              {isOpen ? "Close" : "Enter"}
                            </Link>
                          </>
                        )}
                      </div>
                    </div>

                    {isOpen ? (
                      <div className="border-t border-slate-200 p-3 dark:border-slate-800">
                        <form action={approve} className="space-y-3">
                          <input type="hidden" name="receiptId" value={receipt.id} />
                          {/* Two columns, read across: what it is and when,
                              who and when it is due, the reference pair, then
                              the figures, then the currency pair. */}
                          <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="Record as">
                              <Select name="kind" defaultValue="DIRECT">
                                <option value="DIRECT">Direct expense — already paid</option>
                                <option value="BILL">Bill — owed, pay later</option>
                              </Select>
                            </Field>
                            <Field label="Date">
                              <Input
                                type="date"
                                name="date"
                                defaultValue={isoDate(receipt.readDate ?? today())}
                              />
                            </Field>
                            <Field label="Vendor" hint="Required for a bill.">
                              <Select name="vendorId" defaultValue="">
                                <option value="">None</option>
                                {vendors.map((vendor) => (
                                  <option key={vendor.id} value={vendor.id}>
                                    {vendor.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label="Due date" hint="Used for a bill.">
                              <Input type="date" name="dueDate" />
                            </Field>
                            <Field label="Reference">
                              <Input name="reference" />
                            </Field>
                            <Field label="Paid from" hint="Used for a direct expense.">
                              <Select name="paymentAccountId" defaultValue={paymentAccounts[0]?.id}>
                                {paymentAccounts.map((account) => (
                                  <option key={account.id} value={account.id}>
                                    {account.code} — {account.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label="Description">
                              <Input
                                name="description"
                                required
                                defaultValue={
                                  receipt.readDescription ?? receipt.readVendorName ?? ""
                                }
                              />
                            </Field>
                            <Field label="Amount">
                              <Input
                                name="amount"
                                inputMode="decimal"
                                required
                                defaultValue={
                                  receipt.readAmount ? money(receipt.readAmount).toFixed(2) : ""
                                }
                              />
                            </Field>
                            <Field label="Expense account">
                              <Select
                                name="expenseAccountId"
                                defaultValue={expenseAccounts[0]?.id}
                                required
                              >
                                {expenseAccounts.map((account) => (
                                  <option key={account.id} value={account.id}>
                                    {account.code} — {account.name}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field
                              label="File link"
                              hint="Optional. Paste a Google Drive link and it becomes a click-through on the expense."
                            >
                              <Input
                                name="fileUrl"
                                type="url"
                                inputMode="url"
                                placeholder="https://drive.google.com/…"
                              />
                            </Field>
                            <Field label="Currency">
                              <Select
                                name="currency"
                                defaultValue={receipt.readCurrency ?? company.baseCurrency}
                              >
                                {SUPPORTED_CURRENCIES.map((currency) => (
                                  <option key={currency.code} value={currency.code}>
                                    {currency.code}
                                  </option>
                                ))}
                              </Select>
                            </Field>
                            <Field label={`Exchange rate (${company.baseCurrency} per unit)`}>
                              <Input name="fxRate" inputMode="decimal" defaultValue="1" />
                            </Field>
                            {/* Last cell of the right column, so the button
                                lands under the figures it commits rather than
                                under the whole form. */}
                            <div className="flex flex-col items-end sm:col-start-2">
                              <Button type="submit">Save</Button>
                              <p className="mt-1 text-xs text-slate-500">
                                The photo is attached to the expense.
                              </p>
                            </div>
                          </div>
                        </form>

                        <form action={dismiss} className="mt-3 flex items-end gap-2">
                          <input type="hidden" name="receiptId" value={receipt.id} />
                          <div className="flex-1">
                            <Field label="Not an expense?">
                              <Input name="reason" placeholder="Reason, optional" />
                            </Field>
                          </div>
                          <Button variant="secondary" type="submit">
                            Dismiss
                          </Button>
                        </form>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card tone="muted">
          <h2 className="mb-3 text-sm font-semibold">Add photos</h2>
          <form action={upload} className="space-y-4">
            <Field
              label="Receipt photos"
              hint="Several at once is fine. On a phone this offers the camera."
            >
              <Input
                type="file"
                name="photos"
                accept="image/*"
                capture="environment"
                multiple
                required
              />
            </Field>
            <Button type="submit">Upload</Button>
          </form>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            {reads ? (
              <>
                Each photo is read for its date, total and description. What it
                reads is a suggestion — the figures you approve are the ones
                recorded.
              </>
            ) : (
              <>
                Reading photos automatically is off. Photos are stored and
                listed here; type the date, amount and description in yourself.
                Set ANTHROPIC_API_KEY in the deployment to turn reading on — it
                applies to new uploads, and nothing else changes.
              </>
            )}
          </p>
        </Card>
      </div>
      )}
    </>
  );
}

type ForwardedRow = {
  id: string;
  receivedAt: Date;
  subject: string;
  fromAddress: string;
  deliveredTo: string | null;
  snippet: string | null;
  status: "WAITING" | "RECORDED" | "DISMISSED";
  dismissedReason: string | null;
  attachments: {
    id: string;
    filename: string;
    viewUrl: string | null;
    uploadError: string | null;
  }[];
  expense: { id: string; kind: string; reference: string | null; description: string } | null;
};

/**
 * Bills that arrived by email (SPEC §8.2 extension).
 *
 * A table rather than the card list the photos use, because every row here
 * answers the same four questions — when it came, what it says it is, where
 * the file is, and what you are going to do about it — and a table is how
 * you read forty of those.
 *
 * The two buttons are links into the ordinary expense screens rather than a
 * form of their own. A bill entered from a forwarded email is an ordinary
 * bill: it should be checked, coded and posted by the same screen as every
 * other, with the subject and the Drive link carried over as a starting
 * point.
 */
function ForwardedList({
  rows,
  showDismissed,
  inboxAddress,
  dismiss,
  restore,
}: {
  rows: ForwardedRow[];
  showDismissed: boolean;
  inboxAddress: string | null;
  dismiss: (formData: FormData) => Promise<void>;
  restore: (formData: FormData) => Promise<void>;
}) {
  const record = (row: ForwardedRow, kind: "direct" | "bill") => {
    const query = new URLSearchParams({ inbox: row.id });
    if (kind === "bill") query.set("tab", "bill");
    return `/expenses/new?${query.toString()}`;
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{showDismissed ? "Dismissed" : "Waiting"}</h2>
        <Link
          className="text-xs underline"
          href={showDismissed ? "/receipts?tab=email" : "/receipts?tab=email&show=dismissed"}
        >
          {showDismissed ? "Back to the queue" : "Show dismissed"}
        </Link>
      </div>

      {!inboxAddress ? (
        <Alert tone="info">
          This book has no forwarding address yet, so nothing can arrive. Set
          one under{" "}
          <Link className="underline" href="/receipts/settings">
            Bills by email
          </Link>
          .
        </Alert>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState title={showDismissed ? "Nothing dismissed" : "Nothing forwarded yet"}>
          {showDismissed
            ? "Messages you set aside show up here, and can be put back."
            : inboxAddress
              ? `Forward a bill to ${inboxAddress} and it will appear here within the hour, with its attachments filed in Drive.`
              : "Once this book has an address, anything forwarded to it lands here."}
        </EmptyState>
      ) : (
        <DataTable>
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2">Forwarded</th>
              <th className="py-2">Subject</th>
              <th className="py-2">File</th>
              <th className="py-2 text-right">Record as</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-100 align-top dark:border-slate-800/60">
                <td className="whitespace-nowrap py-2 text-sm">
                  {formatAccountingDate(row.receivedAt)}
                </td>
                <td className="py-2 text-sm">
                  <div className="font-medium">{row.subject}</div>
                  <div className="text-xs text-slate-500">
                    {row.fromAddress}
                    {row.deliveredTo ? ` · to ${row.deliveredTo}` : ""}
                  </div>
                  {row.snippet ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{row.snippet}</p>
                  ) : null}
                  {row.dismissedReason ? (
                    <p className="mt-0.5 text-xs text-slate-500">
                      Dismissed: {row.dismissedReason}
                    </p>
                  ) : null}
                </td>
                <td className="py-2 text-sm">
                  {row.attachments.length === 0 ? (
                    // Worth saying rather than leaving blank: a bill in the
                    // body of an email is still a bill, and the reader needs
                    // to know there is nothing to open.
                    <span className="text-xs text-slate-400">Nothing attached</span>
                  ) : (
                    <ul className="space-y-0.5">
                      {row.attachments.map((file) => (
                        <li key={file.id}>
                          {file.viewUrl ? (
                            <a
                              className="text-xs underline"
                              href={file.viewUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              {file.filename}
                            </a>
                          ) : (
                            <span
                              className="text-xs text-amber-700 dark:text-amber-400"
                              title={file.uploadError ?? undefined}
                            >
                              {file.filename} — not filed
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-2 text-right">
                  {row.status === "RECORDED" && row.expense ? (
                    <Link className="text-sm underline" href={`/expenses/${row.expense.id}`}>
                      {row.expense.kind === "BILL" ? "Bill" : "Expense"}{" "}
                      {row.expense.reference ?? "recorded"}
                    </Link>
                  ) : showDismissed ? (
                    <form action={restore}>
                      <input type="hidden" name="messageId" value={row.id} />
                      <Button variant="ghost" type="submit">
                        Put back
                      </Button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Link href={record(row, "direct")}>
                        <Button variant="secondary" type="button">
                          Direct expense
                        </Button>
                      </Link>
                      <Link href={record(row, "bill")}>
                        <Button type="button">Bill</Button>
                      </Link>
                      <form action={dismiss}>
                        <input type="hidden" name="messageId" value={row.id} />
                        <Button variant="ghost" type="submit">
                          Dismiss
                        </Button>
                      </form>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Card>
  );
}
