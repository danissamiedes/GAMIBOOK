import Link from "next/link";
import { prisma } from "@/lib/db";
import { companyScope } from "@/lib/session-scope";
import { formatDateTimeInZone } from "@/lib/time/zone";
import { Alert, Card, DataTable, EmptyState, PageHeader } from "@/components/ui";

export const metadata = { title: "Email log — Ledger" };

const STATUS_STYLES: Record<string, string> = {
  QUEUED: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  SENT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

/** SPEC §10: every attempt, filterable by document and by batch. */
export default async function EmailLogPage({
  searchParams,
}: {
  searchParams: Promise<{ relatedId?: string; batch?: string; status?: string }>;
}) {
  const scope = await companyScope();
  scope.requireRole("OWNER", "BOOKKEEPER");
  const params = await searchParams;

  const company = await prisma.company.findFirstOrThrow({ where: { id: scope.companyId } });

  const logs = await prisma.emailLog.findMany({
    where: {
      ...scope.where,
      ...(params.relatedId ? { relatedId: params.relatedId } : {}),
      ...(params.batch ? { emailBatchId: params.batch } : {}),
      ...(params.status ? { status: params.status as "QUEUED" | "SENT" | "FAILED" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const dryRunCount = logs.filter((log) => log.gmailMessageId === "dry-run").length;

  return (
    <>
      <PageHeader
        title="Email log"
        description="Every attempt, whether it succeeded, failed or was a dry run."
      />

      {dryRunCount > 0 ? (
        <Alert tone="warning">
          {dryRunCount} of these were dry runs — logged, never actually sent.
        </Alert>
      ) : null}

      {logs.length === 0 ? (
        <EmptyState title="Nothing sent yet">
          Every attempt lands here — successes and failures alike, with the reason a message was
          refused. Send an invoice or a work order and it will show up.
        </EmptyState>
      ) : (
        <Card>
          <DataTable>
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">When</th>
                <th className="py-2">To</th>
                <th className="py-2">Subject</th>
                <th className="py-2">Attachments</th>
                <th className="py-2">Document</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2 whitespace-nowrap">
                    {formatDateTimeInZone(log.createdAt, company.operatingTimeZone)}
                  </td>
                  <td className="py-2">
                    {log.toAddresses.join(", ") || <span className="text-slate-400">—</span>}
                    {log.cc.length > 0 ? (
                      <div className="text-xs text-slate-500">cc {log.cc.join(", ")}</div>
                    ) : null}
                  </td>
                  <td className="py-2">{log.subject}</td>
                  <td className="py-2 text-xs text-slate-500">
                    {log.attachmentNames.join(", ") || "—"}
                  </td>
                  <td className="py-2 text-xs">
                    {log.relatedType === "Invoice" && log.relatedId ? (
                      <Link className="underline" href={`/invoices/${log.relatedId}`}>
                        invoice
                      </Link>
                    ) : log.relatedType === "WorkOrder" && log.relatedId ? (
                      <Link className="underline" href={`/work-orders/${log.relatedId}`}>
                        work order
                      </Link>
                    ) : (
                      (log.relatedType ?? "—")
                    )}
                  </td>
                  <td className="py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                        STATUS_STYLES[log.status]
                      }`}
                    >
                      {log.gmailMessageId === "dry-run" ? "dry run" : log.status.toLowerCase()}
                    </span>
                    {log.error ? (
                      <div className="mt-1 max-w-sm text-xs text-red-600 dark:text-red-400">
                        {log.error}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </Card>
      )}
    </>
  );
}
