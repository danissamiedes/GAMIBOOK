import Link from "next/link";
import type { Customer } from "@prisma/client";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { create, save } from "./actions";

/**
 * The customer form, shared by the New screen and the customer's own page.
 * It used to sit beside the list, which meant editing somebody happened on a
 * screen showing everybody.
 */
export function CustomerForm({
  editing,
  baseCurrency,
  error,
}: {
  editing: Customer | null;
  /** The company's own currency, for the hint and the default. */
  baseCurrency: string;
  error?: string;
}) {
  return (
    <>
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
    <Card tone="muted">
      {editing ? (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Currency and terms are the defaults for the next invoice. Invoices
          already issued keep the ones they were raised with.
        </p>
      ) : null}
      {/* One form for both. The key remounts it when the row changes, so
          switching from one customer to another does not leave the first
          one's values sitting in the fields. */}
      <form
        key={editing?.id ?? "new"}
        action={editing ? save : create}
        className="space-y-4"
      >
        {editing ? (
          <input type="hidden" name="customerId" value={editing.id} />
        ) : null}
        <Field label="Name">
          <Input name="name" required defaultValue={editing?.name ?? ""} />
        </Field>
        <Field label="Invoice emails" hint="Comma separated.">
          <Input name="emails" type="text" defaultValue={editing?.emails.join(", ") ?? ""} />
        </Field>
        <Field
          label="Currency"
          hint={`Books are kept in ${baseCurrency}; invoices may be in another currency.`}
        >
          <Select
            name="defaultCurrency"
            defaultValue={editing?.defaultCurrency ?? baseCurrency}
          >
            {SUPPORTED_CURRENCIES.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code} — {currency.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Payment terms (days)">
          <Input
            name="paymentTermsDays"
            type="number"
            defaultValue={editing?.paymentTermsDays ?? 30}
            min={0}
          />
        </Field>
        <Field label="Billing address">
          <Input name="billingAddress" defaultValue={editing?.billingAddress ?? ""} />
        </Field>
        <Field label="Standing note" hint="One line always shown on this record. The dated notes are beside this.">
          <Input name="notes" defaultValue={editing?.notes ?? ""} />
        </Field>
        {editing ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={editing.isActive}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            />
            Active
          </label>
        ) : null}
        {editing ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="sendEmails"
              defaultChecked={editing.sendEmails}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
            />
            <span>
              Send overdue reminders
              <span className="block text-xs text-slate-500">
                Off stops the weekly chase for this customer. Their invoices still send.
              </span>
            </span>
          </label>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit">{editing ? "Save changes" : "Add customer"}</Button>
          {editing ? (
            <Link
              href={editing ? `/customers/${editing.id}` : "/customers"}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </Link>
          ) : null}
        </div>
      </form>
    </Card>
    </>
  );
}
