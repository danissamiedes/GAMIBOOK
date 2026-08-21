/**
 * Starts the in-process scheduler on a host that keeps a process running
 * between requests — that is, the single-VPS deployment (SPEC §7.2, §9).
 *
 * This hook is why the scheduler exists at all: `startScheduler()` was written
 * in Phase 7 and never called, so the recurring-invoice run and the stale-shift
 * auto-close had never fired on their own in any deployment.
 *
 * Serverless has no process to keep timers in. There, SCHEDULER_ENABLED stays
 * false and /api/cron does the same work when something outside knocks.
 */
export async function register() {
  // The scheduler pulls in Prisma and the whole posting path, neither of which
  // loads on the edge runtime.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SCHEDULER_ENABLED !== "true") return;

  const { startScheduler } = await import("@/lib/scheduler");
  startScheduler();
}
