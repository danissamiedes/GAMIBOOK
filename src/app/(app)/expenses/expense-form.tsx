import Link from "next/link";
import { isoDate, today } from "@/lib/dates";
import { Button, Card, Field, Input, Select } from "@/components/ui";

type Option = { id: string; code: string; name: string };
type Party = { id: string; name: string; defaultCurrency: string };

export type ExpenseFormValues = {
  id: string;
  kind: "DIRECT" | "BILL";
  date: Date;
  dueDate: Date | null;
  vendorId: string | null;
  description: string;
  reference: string | null;
  amount: string;
  currency: string;
  fxRate: string;
  expenseAccountId: string;
  paymentAccountId: string | null;
  receiptUrl: string | null;
};

/**
 * The one form that records and corrects an expense (SPEC §8.2).
 *
 * It is the same fields in the same order wherever it is used — a direct
 * expense, a supplier's bill, a consultant's bill, new or being corrected —
 * because the alternative is four forms that drift apart, and a person who
 * has to find "Reference" again on every screen.
 *
 * It renders on a screen of its own rather than in a column beside a list.
 * A form squeezed next to a hundred rows is a form people mis-type into, and
 * on a phone it sits below them where nobody scrolls.
 */
export function ExpenseForm({
  action,
  kind,
  editing,
  parties,
  partyLabel,
  partyRequired,
  expenseAccounts,
  paymentAccounts,
  baseCurrency,
  cancelHref,
  showFileLink = true,
  startingFrom,
}: {
  action: (formData: FormData) => void;
  kind: "DIRECT" | "BILL";
  editing: ExpenseFormValues | null;
  parties: Party[];
  partyLabel: string;
  partyRequired: boolean;
  expenseAccounts: Option[];
  paymentAccounts: Option[];
  baseCurrency: string;
  cancelHref: string;
  showFileLink?: boolean;
  /**
   * A forwarded email this is being entered from (SPEC §8.2 extension).
   * Its subject and Drive link fill the form in as a starting point, and
   * its id rides along so the inbox row is crossed off on save. Everything
   * remains editable: what arrived by email is a claim, not a figure.
   */
  startingFrom?: {
    messageId: string;
    subject: string;
    fileUrl: string | null;
    from: string;
  } | null;
}) {
  const currencies = [...new Set([baseCurrency, ...parties.map((party) => party.defaultCurrency)])];

  return (
    <Card>
      {editing ? (
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          This has already posted. Saving reverses that entry and posts the corrected one, dated
          to the original so the month it belongs to stays right.
        </p>
      ) : null}

      {startingFrom ? (
        <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
          From the email <span className="font-medium">{startingFrom.subject}</span>, forwarded
          by {startingFrom.from}. Check every figure against the attachment — nothing was read
          off it.
          {startingFrom.fileUrl ? (
            <>
              {" "}
              <a
                className="underline"
                href={startingFrom.fileUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open the file
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}

      <form action={action} className="space-y-4">
        <input type="hidden" name="kind" value={kind} />
        {editing ? <input type="hidden" name="expenseId" value={editing.id} /> : null}
        {startingFrom ? (
          <input type="hidden" name="inboxMessageId" value={startingFrom.messageId} />
        ) : null}

        {/* What and when, who, what it was, what it cost, where it lands,
            then the currency pair. Currency and its rate share a row because
            both are narrow and always read together. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" name="date" defaultValue={isoDate(editing?.date ?? today())} />
          </Field>
          <Field
            label="Reference"
            hint="Required — the OR, invoice or cheque number this comes from."
          >
            <Input name="reference" required defaultValue={editing?.reference ?? ""} />
          </Field>

          <Field
            label={partyLabel}
            hint={partyRequired ? "Required — this is who you owe." : undefined}
          >
            <Select name="vendorId" defaultValue={editing?.vendorId ?? ""} required={partyRequired}>
              <option value="">{partyRequired ? "Select…" : "None"}</option>
              {parties.map((party) => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input
              name="amount"
              inputMode="decimal"
              required
              defaultValue={editing?.amount ?? ""}
            />
          </Field>

          <div className="sm:col-span-2">
            <Field label="Description">
              <Input
                name="description"
                required
                defaultValue={editing?.description ?? startingFrom?.subject ?? ""}
              />
            </Field>
          </div>

          <Field label="Expense account">
            <Select
              name="expenseAccountId"
              defaultValue={editing?.expenseAccountId ?? expenseAccounts[0]?.id}
              required
            >
              {expenseAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
            </Select>
          </Field>

          {kind === "BILL" ? (
            <Field label="Due date">
              <Input
                type="date"
                name="dueDate"
                defaultValue={editing?.dueDate ? isoDate(editing.dueDate) : ""}
              />
            </Field>
          ) : (
            <Field label="Paid from">
              <Select
                name="paymentAccountId"
                defaultValue={editing?.paymentAccountId ?? paymentAccounts[0]?.id}
                required
              >
                {paymentAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Currency">
            <Select name="currency" defaultValue={editing?.currency ?? baseCurrency}>
              {currencies.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Exchange rate (${baseCurrency} per unit)`}>
            <Input name="fxRate" inputMode="decimal" defaultValue={editing?.fxRate ?? "1"} />
          </Field>

          {showFileLink ? (
            <div className="sm:col-span-2">
              <Field
                label="File link"
                hint="Optional. A Google Drive link, say — it becomes a click-through on the list."
              >
                <Input
                  name="fileUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://drive.google.com/…"
                  defaultValue={editing?.receiptUrl ?? startingFrom?.fileUrl ?? ""}
                />
              </Field>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button type="submit">{editing ? "Save changes" : "Record it"}</Button>
          <Link
            href={cancelHref}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
