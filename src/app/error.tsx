"use client";

/**
 * The root error boundary.
 *
 * (app)/error.tsx only covers the signed-in section. The landing page, sign-in,
 * the invite and reset-password screens sit outside it, so anything they threw
 * fell through to the host's own "A server error occurred" — which tells the
 * person nothing, and tells whoever is debugging it nothing either.
 *
 * The commonest cause by far is the database being unreachable, and the most
 * useful thing this can do is say so and print the digest that matches the
 * server log.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">Ledger</h1>
      <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
        This page could not be loaded.
      </p>

      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
        Something the app depends on did not respond — most often the database.
        Nothing was changed. Try again in a moment.
      </div>

      {error.digest ? (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          If it keeps happening, the server log holds the reason. Quote this reference:{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
            {error.digest}
          </code>
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button
          onClick={reset}
          className="h-9 rounded-md border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
        >
          Try again
        </button>
        <a
          href="/login"
          className="flex h-9 items-center rounded-md border border-slate-300 px-3 text-sm font-medium dark:border-slate-700"
        >
          Go to sign in
        </a>
      </div>
    </main>
  );
}
