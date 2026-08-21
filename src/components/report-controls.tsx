import type { ReactNode } from "react";
import { Button, Card, Field, Input } from "@/components/ui";

/**
 * Date-range controls with the presets SPEC §12 asks for. A plain form with a
 * GET action, so a report is a URL — which is what makes one shareable and
 * bookmarkable.
 */
export function ReportControls({
  presets,
  children,
  csvHref,
}: {
  presets: { label: string; href: string }[];
  children: ReactNode;
  csvHref?: string;
}) {
  return (
    <Card className="mb-4 print:hidden">
      <form className="flex flex-wrap items-end gap-3">
        {children}
        <Button type="submit">Update</Button>
        {csvHref ? (
          <a href={csvHref}>
            <Button variant="secondary" type="button">
              Export CSV
            </Button>
          </a>
        ) : null}
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {presets.map((preset) => (
          <a key={preset.label} href={preset.href}>
            <Button variant="ghost" type="button">
              {preset.label}
            </Button>
          </a>
        ))}
      </div>
    </Card>
  );
}

export function DateField({
  label,
  name,
  value,
  hint,
}: {
  label: string;
  name: string;
  value: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input type="date" name={name} defaultValue={value} />
    </Field>
  );
}
