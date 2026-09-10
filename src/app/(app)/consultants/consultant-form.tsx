import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";
import { Alert, Button, Card, Field, Input, Select } from "@/components/ui";
import { create, save } from "./actions";

type Consultant = Prisma.VendorGetPayload<{ include: { user: { select: { email: true } } } }>;

/**
 * The consultant form, in one place for the New screen and the consultant's
 * own page.
 *
 * It used to sit beside the list, which meant editing somebody happened on a
 * screen showing everybody. The fields now live with the person they describe.
 */
export function ConsultantForm({
  editing,
  expenseAccounts,
  error,
}: {
  /** The consultant being edited, or null when this is a new one. */
  editing: Consultant | null;
  expenseAccounts: { id: string; code: string; name: string }[];
  error?: string;
}) {
  return (
    <>
      {error === "name" ? <Alert tone="error">A name is required.</Alert> : null}
      {error === "currency" ? <Alert tone="error">Pick a supported currency.</Alert> : null}
      {error === "email" ? (
        <Alert tone="error">
          An address is needed to include somebody in work order emails.
        </Alert>
      ) : null}
      {error === "terms" ? (
        <Alert tone="error">Payment terms are a whole number of days, and not negative.</Alert>
      ) : null}
    <Card tone="muted">
      {editing ? (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Currency, rate, terms and account are the defaults for the next
          work order. Work orders already raised keep theirs.
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
        <Field label="Cc" hint="Comma separated — a manager or agency contact.">
          <Input name="ccEmails" defaultValue={editing?.ccEmails.join(", ") ?? ""} />
        </Field>
        <Field label="Address">
          <Input name="address" defaultValue={editing?.address ?? ""} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="sendEmails"
            defaultChecked={editing ? editing.sendEmails : true}
          />
          Include in work order emails
        </label>
        <Field label="Currency">
          <Select name="defaultCurrency" defaultValue={editing?.defaultCurrency ?? "PHP"}>
            {SUPPORTED_CURRENCIES.map((currency) => (
              <option key={currency.code} value={currency.code}>
                {currency.code} — {currency.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default rate">
          <Input
            name="defaultRate"
            inputMode="decimal"
            defaultValue={editing?.defaultRate ? editing.defaultRate.toFixed(2) : ""}
          />
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
            defaultValue={editing?.paymentTermsDays ?? 15}
            min={0}
          />
        </Field>
        <Field label="Standing note" hint="One line always shown on this record. The dated notes are beside this.">
          <Input name="notes" defaultValue={editing?.notes ?? ""} />
        </Field>
        <Field
          label="Spreadsheet code"
          hint="Optional. Helps the import match this person when a sheet names them differently."
        >
          <Input name="externalRef" defaultValue={editing?.externalRef ?? ""} />
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
          <Button type="submit">{editing ? "Save changes" : "Add consultant"}</Button>
          {editing ? (
            <Link
              href={editing ? `/consultants/${editing.id}` : "/consultants"}
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
