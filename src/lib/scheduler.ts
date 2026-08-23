import { autoCloseStaleEntries } from "@/lib/time/clock";
import { runRecurringInvoices } from "@/lib/invoices/recurring";
import { runRecurringBills } from "@/lib/payables/recurring-bills";
import { pruneRateLimits } from "@/lib/rate-limit";

/**
 * In-process scheduler (SPEC §7.2, §8.2a, §9): the stale-shift auto-close and
 * the two recurring runs, invoices out and bills in.
 *
 * The jobs themselves are plain functions that take no scheduler state, so
 * moving this to a queue later means replacing this file and nothing else.
 * Nothing schedules itself on import: a server that runs several instances
 * would otherwise run every job several times.
 */

export type Job = {
  name: string;
  /** Minutes between runs. */
  everyMinutes: number;
  run: () => Promise<unknown>;
};

export const JOBS: Job[] = [
  {
    name: "auto-close-stale-shifts",
    everyMinutes: 15,
    run: () => autoCloseStaleEntries(),
  },
  {
    // Hourly rather than daily, because "06:00" is 06:00 in each company's own
    // operating zone and those do not share an hour. The job itself decides
    // whether a company is due, and generating twice is a no-op (SPEC §7.2).
    name: "recurring-invoices",
    everyMinutes: 60,
    run: () => runRecurringInvoices(),
  },
  {
    // Same reasoning as the invoice run above, and separate from it on purpose:
    // a failure recording one company's rent must not stop anyone's invoices
    // going out, and the cron route reports each job's outcome by name.
    name: "recurring-bills",
    everyMinutes: 60,
    run: () => runRecurringBills(),
  },
  {
    // Housekeeping. Nothing depends on it — an expired window is ignored
    // whether or not its row is still there.
    name: "prune-rate-limits",
    everyMinutes: 60 * 24,
    run: () => pruneRateLimits(),
  },
];

const timers = new Map<string, NodeJS.Timeout>();

export function startScheduler(): void {
  if (process.env.SCHEDULER_ENABLED !== "true") return;
  for (const job of JOBS) {
    if (timers.has(job.name)) continue;
    const timer = setInterval(
      () => {
        void job.run().catch((error) => {
          console.error(`[scheduler] ${job.name} failed`, error);
        });
      },
      job.everyMinutes * 60_000,
    );
    timer.unref?.();
    timers.set(job.name, timer);
  }
}

export function stopScheduler(): void {
  for (const [name, timer] of timers) {
    clearInterval(timer);
    timers.delete(name);
  }
}

/** Run one job now, by name — used by the admin screen and by tests. */
export async function runJobNow(name: string) {
  const job = JOBS.find((candidate) => candidate.name === name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  return job.run();
}
