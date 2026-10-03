/**
 * What a page looks like before its data arrives.
 *
 * This file does more than show a skeleton. A dynamic route is not prefetched
 * at all unless it has one — so without it, every click in the nav sat on the
 * old page doing nothing visible until the server had finished the whole render.
 * With it, Next can fetch the shell ahead of the click and swap to this the
 * instant one happens, which is the difference between an app that feels slow
 * and one that feels busy.
 *
 * Deliberately vague: it stands in for every page in the section, so it shows
 * the shape of a page — a heading, a block of content — rather than pretending
 * to know which one is coming.
 */
export default function Loading() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-7 w-56 rounded-md bg-slate-200 dark:bg-slate-800" />
      <div className="mb-6 h-4 w-80 rounded bg-slate-100 dark:bg-slate-800/60" />
      <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        {[0, 1, 2, 3, 4].map((row) => (
          <div
            key={row}
            className="flex items-center gap-4 border-b border-slate-100 py-3 last:border-0 dark:border-slate-800/60"
          >
            <div className="h-4 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
            <div className="h-4 w-24 rounded bg-slate-100 dark:bg-slate-800/60" />
            <div className="h-4 w-16 rounded bg-slate-100 dark:bg-slate-800/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
