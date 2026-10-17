import { Field, Input } from "@/components/ui";

/**
 * A text box that filters a list by what it contains.
 *
 * Sits inside the same GET form as the period filter, so applying one keeps
 * the others and the filtered list stays a URL — shareable, bookmarkable and
 * correct on reload.
 *
 * Unlike the dropdowns beside it, this does not submit on change: half a word
 * is not an answer, so it waits for Enter or Apply. That also means it needs
 * no JavaScript of its own.
 */
export function FilterText({
  name,
  label,
  value,
  placeholder,
  hint,
  className = "w-48",
}: {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        name={name}
        type="search"
        defaultValue={value}
        placeholder={placeholder}
        className={className}
        aria-label={label}
      />
    </Field>
  );
}
