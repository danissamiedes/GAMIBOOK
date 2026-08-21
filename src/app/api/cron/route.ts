import { createHash, timingSafeEqual } from "node:crypto";
import { JOBS } from "@/lib/scheduler";

/**
 * Scheduled jobs for a host with no long-lived process (SPEC §7.2, §9).
 *
 * On a VPS the in-process scheduler in instrumentation.ts runs these. Serverless
 * has nothing running between requests, so something outside has to knock:
 * Vercel Cron, GitHub Actions, or any pinger that can set a header.
 *
 * Every job is idempotent — a recurring invoice already generated for a period
 * is not generated again, and closing an already-closed shift does nothing — so
 * calling this more often than needed is safe, and calling it late only delays
 * work rather than losing it. That is what makes it safe to run all of them on
 * one schedule instead of keeping separate timers per job.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Compare through a fixed-length digest so the check is constant-time whatever
 * the lengths are, and a wrong guess cannot be narrowed down by timing it.
 */
function secretMatches(offered: string, expected: string): boolean {
  const a = createHash("sha256").update(offered).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Vercel Cron sends the Authorization header itself when CRON_SECRET is set.
  // x-cron-key is for external pingers that only offer a custom header. The
  // secret is deliberately not accepted in the query string: URLs end up in
  // access logs, browser history and referrers.
  const offered =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-key") ??
    "";

  return Boolean(offered) && secretMatches(offered, expected);
}

async function runJobs(only: string | null) {
  const due = only ? JOBS.filter((job) => job.name === only) : JOBS;
  if (only && due.length === 0) {
    return { status: 404 as const, body: { error: `Unknown job: ${only}` } };
  }

  const started = Date.now();
  const results = [];
  for (const job of due) {
    const at = Date.now();
    try {
      const result = await job.run();
      results.push({ job: job.name, ok: true, ms: Date.now() - at, result: result ?? null });
    } catch (error) {
      // One failing job must not stop the others: the recurring-invoice run and
      // the stale-shift close have nothing to do with each other.
      console.error(`[cron] ${job.name} failed`, error);
      results.push({
        job: job.name,
        ok: false,
        ms: Date.now() - at,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failed = results.some((r) => !r.ok);
  // 500 on failure so the cron provider's own alerting notices. The body still
  // lists what did run.
  return { status: failed ? (500 as const) : (200 as const), body: { ms: Date.now() - started, results } };
}

async function handle(request: Request) {
  if (!authorised(request)) {
    return Response.json({ error: "Not authorised" }, { status: 401 });
  }
  const only = new URL(request.url).searchParams.get("job");
  const { status, body } = await runJobs(only);
  return Response.json(body, { status });
}

/** Vercel Cron issues a GET. */
export const GET = handle;
/** POST for pingers that prefer it. Same work, same guard. */
export const POST = handle;
