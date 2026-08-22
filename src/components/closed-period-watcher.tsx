"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui";

/**
 * The names of posting-date inputs. A date on a form under one of these names
 * is a date something will be posted on; every other date input in the app is
 * either a report filter (`from`, `to`, `asOf`) or a fact about a document that
 * nothing posts on (`dueDate`, `expectedDate`), and warning about those would
 * be wrong.
 *
 * Add to this list when a new posting form uses a new name.
 */
const POSTING_DATE_FIELDS = ["date", "issueDate", "orderDate"];

const SELECTOR = POSTING_DATE_FIELDS.map((name) => `input[type="date"][name="${name}"]`).join(",");

/**
 * Warns an owner, as they type, that the date they have chosen falls inside a
 * closed period (SPEC §4.2 rule 4).
 *
 * Only an owner ever sees this. Everyone else is refused by `postJournalEntry`
 * with a message saying why, and warning someone about something they are about
 * to be stopped from doing is just noise.
 *
 * Mounted once in the app layout rather than dropped into each of the fifteen
 * posting forms, for two reasons: a form added later is covered without anyone
 * remembering to, and there is one place to change if the rule changes. The
 * cost is that it reads the DOM — but these forms are uncontrolled anyway (a
 * server action reads the DOM on submit), so there is no React state holding
 * the current value to read instead.
 */
export function ClosedPeriodWatcher({
  closedThrough,
  display,
}: {
  /** yyyy-mm-dd, so it compares as a string against an input's own value. */
  closedThrough: string;
  /** mm/dd/yyyy, for the sentence. */
  display: string;
}) {
  const pathname = usePathname();
  const [inClosed, setInClosed] = useState(false);

  useEffect(() => {
    const read = () => {
      // An <input type="date"> always reports yyyy-mm-dd whatever the browser
      // chooses to display, so the string comparison is the date comparison.
      const hit = Array.from(document.querySelectorAll<HTMLInputElement>(SELECTOR)).some(
        (input) => input.value !== "" && input.value <= closedThrough,
      );
      setInClosed(hit);
    };

    read();
    // Delegated, so a form revealed by a tab or an Edit link is covered without
    // re-binding. The pathname dependency re-reads after a soft navigation,
    // where this component stays mounted and no event fires.
    document.addEventListener("input", read);
    document.addEventListener("change", read);
    return () => {
      document.removeEventListener("input", read);
      document.removeEventListener("change", read);
    };
  }, [closedThrough, pathname]);

  if (!inClosed) return null;

  return (
    <div className="mb-4">
      <Alert tone="warning">
        The books are closed through {display}. A date on this page falls inside the closed
        period — saving it changes a month that has already been closed. Only an owner can, and
        it shows in the audit trail.
      </Alert>
    </div>
  );
}
