import { sectionScope } from "@/lib/session-scope";
import { PostingError } from "@/lib/errors";
import {
  postReclassificationChunk,
  reverseReclassificationChunk,
} from "@/lib/ledger/reclassify";

/**
 * One chunk of a reclassification — posting it, or undoing it (SPEC §18).
 *
 * A route handler rather than a server action because the page calls it in a
 * loop and wants the progress back each time. Every call re-reads the batch
 * and does only what is still outstanding, so calling it twice over is safe:
 * the work that is done is recorded on the lines themselves.
 */
export const dynamic = "force-dynamic";
/**
 * Sixty seconds is what every Vercel plan allows a function without further
 * configuration. Raise it here if the project is on a plan that permits more;
 * the budget below follows.
 */
export const maxDuration = 60;

/** The chunk stops with time in hand, so it answers rather than being killed. */
const BUDGET_MS = (maxDuration - 15) * 1000;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await sectionScope("REPORTS");
  const { id } = await params;

  let mode = "post";
  try {
    const body = (await request.json()) as { mode?: string };
    if (body.mode === "reverse") mode = "reverse";
  } catch {
    // No body is the ordinary case: post the next chunk.
  }

  try {
    const run = mode === "reverse" ? reverseReclassificationChunk : postReclassificationChunk;
    const progress = await run({
      companyId: scope.companyId,
      reclassificationId: id,
      userId: scope.userId,
      role: scope.role,
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
