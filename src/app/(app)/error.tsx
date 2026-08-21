"use client";

import { Alert, Button, Card, PageHeader } from "@/components/ui";

/**
 * Nothing should reach here in normal use — access is refused before a page
 * renders. When something does, say so plainly rather than showing a stack.
 */
export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <>
      <PageHeader title="Something went wrong" />
      <Card className="max-w-xl">
        <Alert tone="error">
          That action could not be completed. If you were trying to reach a screen your role does
          not cover, ask an owner for access.
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
