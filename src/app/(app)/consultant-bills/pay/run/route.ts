import { sectionScope } from "@/lib/session-scope";
import {
  recordBulkPay,
  RUN_CHUNK,
  type BulkPayLine,
  type PayableKind,
} from "@/lib/payables/bulk-pay";
import { PostingError } from "@/lib/errors";
import { parseAccountingDate } from "@/lib/dates";

/**
 * One chunk of a payment run (SPEC §6).
 *
 * A route handler rather than a server action because the screen calls it in
 * a loop. Each payment is its own transaction and several round trips to the
 * database, so sixty consultants is comfortably more than the sixty seconds a
 * serverless function gets — and what the reader saw when it ran out was the
 * app's own fault page, with no way to tell what had been paid.
 *
 * Every call re-reads what is still outstanding and skips consultants this
 * run has already paid, so calling it again is safe. That matters here more
 * than anywhere else in the app: the thing being repeated is a payment.
 */
export const dynamic = "force-dynamic";
/** Sixty seconds is what every Vercel plan allows without configuration. */
export const maxDuration = 60;
/** Hand back with time in hand rather than being killed mid-run. */
const BUDGET_MS = (maxDuration - 15) * 1000;

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

  let body: {
    lines?: unknown;
    date?: unknown;
    paymentAccountId?: unknown;
    reference?: unknown;
    runId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return new Response("That request could not be read", { status: 400 });
  }

  const lines = readLines(body.lines);
  if (lines.length === 0) {
    return new Response("Nothing left to pay in this run", { status: 400 });
  }

  const date = parseAccountingDate(typeof body.date === "string" ? body.date : null);
  if (!date) return new Response("That payment date could not be read", { status: 400 });

  const paymentAccountId = typeof body.paymentAccountId === "string" ? body.paymentAccountId : "";
  if (!paymentAccountId) return new Response("Choose the account to pay from", { status: 400 });

  // The run id comes from the screen and holds for every chunk of one run.
  // It is what a resumed chunk checks against, so a missing one is refused
  // rather than quietly turning a resumable run into a repeatable one.
  const runId = typeof body.runId === "string" && body.runId.length >= 8 ? body.runId : null;
  if (!runId) return new Response("That payment run could not be identified", { status: 400 });

  try {
    const result = await recordBulkPay({
      companyId: scope.companyId,
      lines,
      date,
      paymentAccountId,
      reference: typeof body.reference === "string" ? body.reference.trim() || null : null,
      userId: scope.userId,
      role: scope.role,
      runId,
      limit: RUN_CHUNK,
      budgetMs: BUDGET_MS,
    });
    return Response.json({
      paid: result.paid,
      failed: result.failed,
      remaining: result.remaining,
      done: result.done,
    });
  } catch (error) {
    if (error instanceof PostingError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
