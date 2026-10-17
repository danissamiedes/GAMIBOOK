import type { ReactNode } from "react";
import { Button, Card } from "@/components/ui";
import { PeriodFields } from "@/components/period-select";
import type { PeriodKey } from "@/lib/reports/date-filter";

/**
 * Date controls with the period dropdown SPEC §12 asks for. A plain form with
 * a GET action, so a report is a URL — which is what makes one shareable and
 * bookmarkable.
 *
 * The dropdown leads, then the dates it resolved to, then whatever else the
 * report needs. It replaced a row of preset links below the form: a link
 * cannot show which period you are on, so the row said nothing about where
 * you were, and every report had drifted into offering a different five.
 */
export function ReportControls({
  periodKey,
  from,
  to,
  mode = "range",
  dateLabel,
  children,
  csvHref,
  pdfHref,
  excelHref,
}: {
  periodKey: PeriodKey;
  /** yyyy-mm-dd. For an as-of report, `to` is the date and `from` is "". */
  from: string;
  to: string;
  /** "asOf" for a report drawn at a single moment rather than over a range. */
  mode?: "range" | "asOf";
  dateLabel?: string;
  children?: ReactNode;
  csvHref?: string;
  pdfHref?: string;
  excelHref?: string;
}) {
  return (
    <Card className="mb-4 print:hidden">
      <form className="flex flex-wrap items-end gap-3">
        <PeriodFields
          value={periodKey}
          from={from}
          to={to}
          mode={mode}
          label={dateLabel}
        />
        {children}
        <Button type="submit">Update</Button>
        {csvHref ? (
          <a href={csvHref}>
            <Button variant="secondary" type="button">
              Export CSV
            </Button>
          </a>
        ) : null}
        {excelHref ? (
          <a href={excelHref}>
            <Button variant="secondary" type="button">
              Export to Excel
            </Button>
          </a>
        ) : null}
        {pdfHref ? (
          <a href={pdfHref} target="_blank" rel="noreferrer">
            <Button variant="secondary" type="button">
              Export PDF
            </Button>
          </a>
        ) : null}
      </form>
    </Card>
  );
}

