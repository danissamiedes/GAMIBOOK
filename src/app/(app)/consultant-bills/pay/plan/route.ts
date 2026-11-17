import { sectionScope } from "@/lib/session-scope";
import { planBulkPay, type BulkPayLine, type PayableKind } from "@/lib/payables/bulk-pay";
import { PostingError } from "@/lib/errors";
import { money } from "@/lib/money";

/**
 * What a selection becomes, before anything is posted (SPEC §6).
 *
 * The confirmation used to be a page reached by GET, with every ticked
 * document named in the query string. A year of bills does not fit in a URL —
 * a request line runs out at about sixteen kilobytes, which is a few hundred
 * rows — so the selection is sent as a body instead, and the answer comes
 * back as data for the screen that already has it.
 */
export const dynamic = "force-dynamic";

function readLines(value: unknown): BulkPayLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as { kind?: unknown; documentId?: unknown; amount?: unknown };
    if (typeof row.documentId !== "string" || row.documentId === "") return [];
    return [
      {
        kind: (row.kind === "workOrder" ? "workOrder" : "bill") as PayableKind,
        documentId: row.documentId,
        amount: typeof row.amount === "string" && row.amount.trim() !== "" ? row.amount : "0",
      },
    ];
  });
}

export async function POST(request: Request) {
  const scope = await sectionScope("CONSULTANTS");

  let body: { lines?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("That request could not be read", { status: 400 });
  }

  const lines = readLines(body.lines);
  if (lines.length === 0) {
    return new Response("Nothing was ticked, so there is nothing to review", { status: 400 });
  }

  try {
    const plan = await planBulkPay({ companyId: scope.companyId, lines });
    return Response.json({
      payable: plan.payable.map((payment) => ({
        vendorId: payment.vendorId,
        consultantName: payment.consultantName,
        currency: payment.currency,
        total: money(payment.total).toFixed(2),
        lines: payment.lines.map((line) => ({
          kind: line.kind,
          documentId: line.documentId,
          label: line.label,
          amount: money(line.amount).toFixed(2),
        })),
      })),
      excluded: plan.excluded.map((payment) => ({
        vendorId: payment.vendorId,
        consultantName: payment.consultantName,
        reason: payment.excludedReason ?? "Cannot be paid in this run",
      })),
      total: money(plan.total).toFixed(2),
      currency: plan.currency,
    });
  } catch (error) {
    if (error instanceof PostingError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
