import { sectionScope } from "@/lib/session-scope";
import { commitExpenseChunk } from "@/lib/imports/expenses";
import { PostingError } from "@/lib/errors";

/**
 * One chunk of an expense import (SPEC §8.3).
 *
 * A route handler rather than a server action because the page calls it in a
 * loop and wants the progress back each time. Every call re-reads the batch
 * and skips rows already imported, so calling it twice over is safe — which
 * matters, because the thing most likely to interrupt a long import is
 * somebody's connection.
 *
 * The scope check is the same one the page uses; the batch id in the URL is
 * filtered by company inside the commit, so another company's batch is not
 * found rather than refused.
 */
export const dynamic = "force-dynamic";
/**
 * Sixty seconds is what every Vercel plan allows a function without further
 * configuration. Raise it here if the project is on a plan that permits more
 * (Fluid compute allows several minutes) — the budget below follows, and
 * nothing else needs changing.
 */
export const maxDuration = 60;

/**
 * The function stops posting with time in hand, so it answers rather than
 * being killed. A killed request loses nothing — every row is marked as it
 * posts — but it costs the browser a round trip and shows the reader an
 * error, which is a poor way to spend a minute.
 */
const BUDGET_MS = (maxDuration - 15) * 1000;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  const scope = await sectionScope("VENDORS");
  const { batchId } = await params;

  let body: {
    accountMap?: Record<string, string>;
    paymentAccountId?: string;
    createVendors?: boolean;
    dateFormat?: "MDY" | "DMY" | "ISO";
  };
  try {
    body = await request.json();
  } catch {
    return new Response("That request could not be read", { status: 400 });
  }

  try {
    const progress = await commitExpenseChunk({
      companyId: scope.companyId,
      batchId,
      accountMap: body.accountMap ?? {},
      paymentAccountId: String(body.paymentAccountId ?? ""),
      createVendors: body.createVendors !== false,
      dateFormat: body.dateFormat,
      userId: scope.userId,
      budgetMs: BUDGET_MS,
    });
    return Response.json(progress);
  } catch (error) {
    if (error instanceof PostingError) {
      return new Response(error.message, { status: 400 });
    }
    throw error;
  }
}
