"use client";

import { useState } from "react";
import { Field, Input, Select } from "@/components/ui";
import { PERIOD_OPTIONS, type PeriodKey } from "@/lib/reports/date-filter";

/**
 * The period dropdown and the dates beside it — the one control every
 * filtered screen in the app uses (SPEC §12).
 *
 * The dropdown comes first because it is the question somebody answers
 * first: most of the time a named period is the whole answer. The dates are
 * there to show what that period resolved to, and to be overtyped when
 * nothing named fits.
 *
 * Two small behaviours keep them honest about each other:
 *
 *   Picking a named period submits at once — there is nothing more to fill
 *   in — and the server renders the boxes with the dates it resolved, so
 *   what is in them always belongs to the period above them.
 *
 *   Typing in a date switches the dropdown to Custom dates, because a date
 *   typed under "Last month" would otherwise be read and then ignored.
 *
 * Without JavaScript neither happens and the form still works: the dropdown
 * is still read and the form's own submit button still submits.
 *
 * `mode` is how a report drawn at a single moment joins in. A balance sheet
 * has no start, so a period means its last day — "Last month" is the balance
 * sheet as it stood at the end of last month — and one As-of box replaces
 * the two.
 */
export function PeriodFields({
  value,
  from,
  to,
  label = "Period",
  mode = "range",
}: {
  value: PeriodKey;
  /** yyyy-mm-dd, as an `<input type="date">` requires. */
  from: string;
  /** The end of the range, or the moment itself when `mode` is "asOf". */
  to: string;
  label?: string;
  mode?: "range" | "asOf";
}) {
  // Controlled, so typing a date can move it to Custom. The component
  // remounts on every navigation, so this never drifts from the URL.
  const [key, setKey] = useState<PeriodKey>(value);

  return (
    <>
      <Field label={label}>
        <Select
          name="period"
          value={key}
          className="w-48"
          onChange={(event) => {
            const next = event.target.value as PeriodKey;
            setKey(next);
            if (next !== "custom") event.currentTarget.form?.requestSubmit();
          }}
        >
          {PERIOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      {mode === "asOf" ? (
        <Field label="As of">
          <Input
            type="date"
            name="asOf"
            defaultValue={to}
            onChange={() => setKey("custom")}
          />
        </Field>
      ) : (
        <>
          <Field label="From">
            <Input
              type="date"
              name="from"
              defaultValue={from}
              onChange={() => setKey("custom")}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              name="to"
              defaultValue={to}
              onChange={() => setKey("custom")}
            />
          </Field>
        </>
      )}
    </>
  );
}
