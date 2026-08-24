"use client";

import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { PERIOD_OPTIONS, type PeriodKey } from "@/lib/reports/date-filter";

/**
 * The period dropdown: Today, This week, This month, or dates you choose.
 *
 * A plain GET form, so the filtered list stays a URL — shareable, bookmarkable
 * and correct on reload. The only thing JavaScript adds is convenience: picking
 * a fixed period submits immediately, because making someone choose "Today" and
 * then press Apply is a step that exists for no reason. Choosing "Custom…"
 * reveals the two date inputs instead of submitting, since submitting then
 * would filter by nothing.
 *
 * Without JavaScript it still works — Apply is always there and always submits.
 *
 * `carry` holds the other filters already on the page. Without it, changing the
 * period would silently clear the status and consultant a person had chosen,
 * which reads as the app losing their place.
 */
export function PeriodFilter({
  value,
  from,
  to,
  carry = {},
  label = "Period",
}: {
  value: PeriodKey;
  /** yyyy-mm-dd, as an `<input type="date">` requires. */
  from: string;
  to: string;
  carry?: Record<string, string | undefined>;
  label?: string;
}) {
  const [key, setKey] = useState<PeriodKey>(value);

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      {Object.entries(carry).map(([name, carried]) =>
        carried ? <input key={name} type="hidden" name={name} value={carried} /> : null,
      )}

      <Field label={label}>
        <Select
          name="period"
          defaultValue={value}
          className="w-44"
          onChange={(event) => {
            const next = event.target.value as PeriodKey;
            setKey(next);
            // Everything but "Custom…" is a complete answer on its own.
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

      {key === "custom" ? (
        <>
          <Field label="From">
            <Input type="date" name="from" defaultValue={from} className="w-44" />
          </Field>
          <Field label="To">
            <Input type="date" name="to" defaultValue={to} className="w-44" />
          </Field>
        </>
      ) : (
        // Kept in the URL's shape but out of the way: switching to a fixed
        // period and back should not lose the dates that were typed.
        <>
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
        </>
      )}

      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}
