"use client";

import { Alert, Button, Card, PageHeader } from "@/components/ui";

/**
 * Nothing should reach here in normal use — access is refused before a page
 * renders, and a rejected posting is reported on the form it came from.
 *
 * What arrives here is the unexpected: a database that could not be reached, a
 * constraint the code did not anticipate. The previous version of this screen
 * offered "ask an owner for access" for every one of them, which sent people
 * looking at their permissions when the cause was elsewhere. Only say that when
 * the error actually is about access.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Next replaces production error messages with a digest, so this only matches
  // in development. When it does not match, claim nothing about the cause.
  const isAccess = /section|access|role/i.test(error.message);

  return (
    <>
      <PageHeader title={isAccess ? "No access to this section" : "Something went wrong"} />
      <Card className="max-w-xl">
        <Alert tone="error">
          {isAccess
            ? "Your access does not include this part of the business. An owner can grant it under Users."
            : "That did not go through, and nothing was saved. This is a fault in the app or its database, not something you did wrong."}
        </Alert>

        {!isAccess ? (
          <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
            Try again — if it keeps happening, the server log holds the reason.
            {error.digest ? (
              <>
                {" "}
                Quote this reference when reporting it:{" "}
                {/* The digest is how a report gets matched to the stack trace the
                    server recorded; without it the log is a haystack. */}
                <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                  {error.digest}
                </code>
              </>
            ) : null}
          </p>
        ) : null}

        <div className="mt-4">
          <Button onClick={reset} variant="secondary">
            Try again
          </Button>
        </div>
      </Card>
    </>
  );
}
