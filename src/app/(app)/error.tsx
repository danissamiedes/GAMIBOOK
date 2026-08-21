"use client";

import { Alert, Button, Card, PageHeader } from "@/components/ui";

/**
 * Nothing should reach here in normal use — access is refused before a page
 * renders. When something does, say so plainly rather than showing a stack.
 */
export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  // Next hides messages from production errors, so match on the digest-safe
  // name where we can and fall back to a plain sentence.
  const isAccess = /section|access|role/i.test(error.message);
  return (
    <>
      <PageHeader title={isAccess ? "No access to this section" : "Something went wrong"} />
      <Card className="max-w-xl">
        <Alert tone="error">
          {isAccess
            ? "Your access does not include this part of the business. An owner can grant it under Users."
            : "That action could not be completed. If you were trying to reach a screen your role does not cover, ask an owner for access."}
        </Alert>
        <div className="mt-4">
          <Button onClick={reset} variant="secondary">
            Try again
          </Button>
        </div>
      </Card>
    </>
  );
}
