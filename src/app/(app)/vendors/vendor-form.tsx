import Link from "next/link";
import type { Vendor } from "@prisma/client";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { create, save } from "./actions";

/**
 * The vendor form, shared by the New screen and the vendor's own page.
 */
export function VendorForm({
  editing,
  baseCurrency,
  expenseAccounts,
  error,
}: {
  editing: Vendor | null;
  baseCurrency: string;
  expenseAccounts: { id: string; code: string; name: string }[];
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
          Currency, terms and account are the defaults for the next bill.
          Bills already recorded keep the ones they were entered with.
        </p>
      ) : null}
      <form
        key={editing?.id ?? "new"}
        action={editing ? save : create}
        className="space-y-4"
      >
        {editing ? <input type="hidden" name="vendorId" value={editing.id} /> : null}
        <Field label="Name">
          <Input name="name" required defaultValue={editing?.name ?? ""} />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" defaultValue={editing?.email ?? ""} />
        </Field>
        <Field label="Address">
          <Input name="address" defaultValue={editing?.address ?? ""} />
        </Field>
        <Field label="Currency">
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
        <Field label="Default expense account">
          <Select name="defaultAccountId" defaultValue={editing?.defaultAccountId ?? ""}>
            <option value="">None</option>
            {expenseAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} — {account.name}
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
        <div className="flex items-center gap-2">
          <Button type="submit">{editing ? "Save changes" : "Add vendor"}</Button>
          {editing ? (
            <Link
              href={editing ? `/vendors/${editing.id}` : "/vendors"}
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
