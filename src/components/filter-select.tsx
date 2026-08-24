"use client";

import { Field, Select } from "@/components/ui";

/**
 * A dropdown that filters a list the moment you choose from it.
 *
 * Sits inside the same GET form as the period filter, so applying one keeps
 * the other — and so the filtered list is still a URL, which is what makes it
 * shareable and correct on reload.
 *
 * It submits on change because every option is a complete answer on its own;
 * there is nothing more to fill in, so an Apply step would exist for no reason.
 * Without JavaScript the form's own Apply button still submits it.
 */
export function FilterSelect({
  name,
  label,
  value,
  options,
  className = "w-44",
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Field label={label}>
      <Select
        name={name}
        defaultValue={value}
        className={className}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}
