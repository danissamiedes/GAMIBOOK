"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { Alert, Button, Field, Input, Select } from "@/components/ui";

export type PickerLine = {
  id: string;
  date: string;
  reference: string;
  sourceType: string;
  description: string;
  debit: string;
  credit: string;
  amount: string;
  blockedReason: string | null;
};

type AccountOption = { id: string; code: string; name: string };

/**
 * Choosing what to move, and saying so twice (SPEC §18).
 *
 * The second saying is the point. Everything on this page posts to the
 * ledger, in bulk, against months that may already have been reported on, so
 * the button does not post: it produces a summary of exactly what is about to
 * happen — how many, out of where, into where, on what date, for what reason
 * — and that summary has the button that posts.
 */
export function ReclassifyPicker({
  lines,
  accounts,
  fromAccount,
  action,
  defaultDate,
  currency,
}: {
  lines: PickerLine[];
  accounts: AccountOption[];
  fromAccount: AccountOption;
  action: (formData: FormData) => void;
  defaultDate: string;
  currency: string;
}) {
  const selectable = useMemo(() => lines.filter((line) => !line.blockedReason), [lines]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toAccountId, setToAccountId] = useState("");
  const [dateMode, setDateMode] = useState<"original" | "single">("original");
  const [date, setDate] = useState(defaultDate);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);

  const toggle = (id: string) => {
    setConfirming(false);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allPicked = selectable.length > 0 && picked.size === selectable.length;
  const toggleAll = () => {
    setConfirming(false);
    setPicked(allPicked ? new Set() : new Set(selectable.map((line) => line.id)));
  };

  const chosen = selectable.filter((line) => picked.has(line.id));
  const totals = chosen.reduce(
    (running, line) => ({
      debit: running.debit + Number(line.debit),
      credit: running.credit + Number(line.credit),
    }),
    { debit: 0, credit: 0 },
  );
  const target = accounts.find((account) => account.id === toAccountId) ?? null;
  const ready = chosen.length > 0 && target !== null;

  const amounts = new Intl.NumberFormat("en-PH", { minimumFractionDigits: 2 });

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="fromAccountId" value={fromAccount.id} />
      {chosen.map((line) => (
        <input key={line.id} type="hidden" name="lineId" value={line.id} />
      ))}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
              <th className="py-2 pr-2">
                <input
                  type="checkbox"
                  className="size-4"
                  aria-label="Select all"
                  checked={allPicked}
                  onChange={toggleAll}
                  disabled={selectable.length === 0}
                />
              </th>
              <th className="py-2 pr-2">Date</th>
              <th className="py-2 pr-2">Reference</th>
              <th className="py-2 pr-2">Type</th>
              <th className="py-2 pr-2">Description</th>
              <th className="py-2 pr-2">Current account</th>
              <th className="py-2 pr-2 text-right">Debit</th>
              <th className="py-2 pr-2 text-right">Credit</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.id}
                className={`border-b border-slate-100 align-top dark:border-slate-800/60 ${
                  line.blockedReason ? "text-slate-400 dark:text-slate-500" : ""
                }`}
              >
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    aria-label={`Select ${line.reference}`}
                    checked={picked.has(line.id)}
                    onChange={() => toggle(line.id)}
                    disabled={Boolean(line.blockedReason)}
                  />
                </td>
                <td className="py-2 pr-2 whitespace-nowrap">{line.date}</td>
                <td className="py-2 pr-2 font-mono text-xs">{line.reference}</td>
                <td className="py-2 pr-2 text-xs uppercase tracking-wide text-slate-500">
                  {line.sourceType.toLowerCase().replace(/_/g, " ")}
                </td>
                <td className="py-2 pr-2">
                  {line.description}
                  {line.blockedReason ? (
                    <span className="block text-xs text-amber-700 dark:text-amber-500">
                      {line.blockedReason}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-2 whitespace-nowrap">
                  {fromAccount.code} {fromAccount.name}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {Number(line.debit) === 0 ? "—" : amounts.format(Number(line.debit))}
                </td>
                <td className="py-2 pr-2 text-right tabular-nums">
                  {Number(line.credit) === 0 ? "—" : amounts.format(Number(line.credit))}
                </td>
                <td className="py-2 text-right font-medium tabular-nums">
                  {amounts.format(Number(line.amount))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-slate-600 dark:text-slate-300" aria-live="polite">
        <strong className="tabular-nums">{chosen.length}</strong> of {selectable.length} selected
        {lines.length - selectable.length > 0
          ? ` · ${lines.length - selectable.length} cannot be moved`
          : ""}
      </p>

      <div className="grid gap-4 border-t border-slate-200 pt-4 sm:grid-cols-3 dark:border-slate-800">
        <Field label="Move to account">
          <Select
            name="toAccountId"
            value={toAccountId}
            onChange={(event) => {
              setToAccountId(event.target.value);
              setConfirming(false);
            }}
          >
            <option value="">Select an account…</option>
            {accounts
              .filter((account) => account.id !== fromAccount.id)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} — {account.name}
                </option>
              ))}
          </Select>
        </Field>

        <Field
          label="Reclassification date"
          hint="Each correction belongs in the month it corrects."
        >
          <Select
            name="dateMode"
            value={dateMode}
            onChange={(event) => {
              setDateMode(event.target.value as "original" | "single");
              setConfirming(false);
            }}
          >
            <option value="original">Each transaction&rsquo;s own date</option>
            <option value="single">One date for all of them</option>
          </Select>
        </Field>

        <Field label="On this date" hint={dateMode === "single" ? undefined : "Not used."}>
          <Input
            type="date"
            name="date"
            value={date}
            disabled={dateMode !== "single"}
            onChange={(event) => {
              setDate(event.target.value);
              setConfirming(false);
            }}
          />
        </Field>

        <div className="sm:col-span-3">
          <Field label="Reason" hint="Kept on the entries and in the audit log.">
            <Input
              name="reason"
              value={reason}
              placeholder="e.g. Fuel miscoded to Repairs in Q3"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </div>

      {confirming && target ? (
        <Alert tone="warning">
          <strong className="block">About to post {chosen.length} reclassification entries</strong>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <Pair term="Out of" value={`${fromAccount.code} ${fromAccount.name}`} />
            <Pair term="Into" value={`${target.code} ${target.name}`} />
            <Pair term="Total debit" value={`${currency} ${amounts.format(totals.debit)}`} />
            <Pair term="Total credit" value={`${currency} ${amounts.format(totals.credit)}`} />
            <Pair
              term="Dated"
              value={dateMode === "single" ? date : "each transaction's own date"}
            />
            <Pair term="Reason" value={reason.trim() || "— none given —"} />
          </dl>
          <span className="mt-2 block text-sm">
            The original postings are left exactly as they are; each one is answered by a new
            balanced entry. This can be reversed afterwards.
          </span>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {confirming && ready ? (
          <>
            <PostButton count={chosen.length} />
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Back
            </Button>
          </>
        ) : (
          <Button type="button" disabled={!ready} onClick={() => setConfirming(true)}>
            Reclassify {chosen.length > 0 ? `${chosen.length} ` : ""}
            {chosen.length === 1 ? "transaction" : "transactions"}
          </Button>
        )}
        {!ready ? (
          <span className="text-xs text-slate-500">
            {chosen.length === 0
              ? "Select the transactions to move."
              : "Choose the account to move them to."}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The one control that posts.
 *
 * Disabled the moment it is pressed, by the form's own pending state rather
 * than by a flag of ours: a second press would be a second batch of entries,
 * and the server's guard against that — which exists — should never be the
 * thing a user meets.
 */
function PostButton({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Posting…" : `Confirm and post ${count} ${count === 1 ? "entry" : "entries"}`}
    </Button>
  );
}

function Pair({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-slate-500">{term}:</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
