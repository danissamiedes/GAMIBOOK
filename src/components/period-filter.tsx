import type { ReactNode } from "react";
import { Button } from "@/components/ui";
import { PeriodFields } from "@/components/period-select";
import type { PeriodKey } from "@/lib/reports/date-filter";

/**
 * The period filter on a list screen: the same dropdown and dates the
 * reports use, plus whatever else that list filters by.
 *
 * A plain GET form, so the filtered list stays a URL — shareable,
 * bookmarkable and correct on reload.
 *
 * `carry` holds filters that are not fields in this form. Without it,
 * changing the period would silently clear them, which reads as the app
 * losing your place.
 *
 * `children` are the other filter controls sharing this form — a status
 * dropdown, a search box. They belong in the same form so that applying one
 * keeps the rest, which is the whole reason the filters live together rather
 * than as separate button rows scattered up the page.
 */
export function PeriodFilter({
  value,
  from,
  to,
  carry = {},
  label = "Period",
  children,
}: {
  value: PeriodKey;
  /** yyyy-mm-dd, as an `<input type="date">` requires. */
  from: string;
  to: string;
  carry?: Record<string, string | undefined>;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      {Object.entries(carry).map(([name, carried]) =>
        carried ? <input key={name} type="hidden" name={name} value={carried} /> : null,
      )}

      <PeriodFields value={value} from={from} to={to} label={label} />

      {children}

      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}
