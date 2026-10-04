/**
 * The booking page before its day arrives.
 *
 * Only ever seen on a cold open of the page: moving along the strip swaps the
 * grid in place now. A dynamic route is not prefetched at all without this
 * file, though, so it also buys the first paint for anyone arriving from a
 * link.
 */
export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl animate-pulse px-4 py-8" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-8 w-64 rounded-md bg-slate-200 dark:bg-slate-800" />
      <div className="mb-6 h-4 w-96 max-w-full rounded bg-slate-100 dark:bg-slate-800/60" />
      <div className="mb-5 flex gap-2">
        {[0, 1, 2, 3, 4, 5, 6].map((tab) => (
          <div key={tab} className="h-16 w-[4.5rem] rounded-lg bg-slate-100 dark:bg-slate-800/60" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div key={row} className="flex gap-2 py-1.5">
              <div className="h-9 w-20 rounded bg-slate-100 dark:bg-slate-800/60" />
              <div className="h-9 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
              <div className="h-9 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
              <div className="h-9 flex-1 rounded bg-slate-100 dark:bg-slate-800/60" />
            </div>
          ))}
        </div>
        <div className="h-64 rounded-xl border border-slate-200 dark:border-slate-800" />
      </div>
    </main>
  );
}
