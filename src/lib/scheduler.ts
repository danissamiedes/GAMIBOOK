import { autoCloseStaleEntries } from "@/lib/time/clock";

/**
 * In-process scheduler (SPEC §7.2, §9). Introduced here for the stale-shift
 * auto-close and reused for recurring invoices in Phase 8.
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
