"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, Button, DataTable, Field, Input, Select } from "@/components/ui";
import { formatMoney } from "@/lib/currency";

export type PayableRow = {
  kind: "bill" | "workOrder";
  id: string;
  consultantName: string;
  label: string;
  date: string;
  dueDate: string | null;
  currency: string;
  balanceDue: string;
  href: string;
};

type AccountOption = { id: string; code: string; name: string };

type PlannedLine = { kind: "bill" | "workOrder"; documentId: string; label: string; amount: string };
type Plan = {
  payable: {
    vendorId: string;
    consultantName: string;
    currency: string;
    total: string;
    lines: PlannedLine[];
  }[];
  excluded: { vendorId: string; consultantName: string; reason: string }[];
  total: string;
  currency: string | null;
};

type RunProgress = {
  paid: { vendorId: string; consultantName: string; billPaymentId: string; total: string }[];
  failed: { vendorId: string; consultantName: string; reason: string }[];
  remaining: number;
  done: boolean;
};

/** The server's own no — not worth asking twice. */
class Refused extends Error {}

/**
 * What to show when the answer was not ours: a host that kills a function
 * answers with its own page, and a wall of HTML in a red box tells a reader
 * nothing.
 */
function readableError(body: string, status: number): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (status === 504 || /TIMEOUT/i.test(text)) {
    return "That batch of payments took too long and the server cut it off";
  }
  if (!text || text.length > 200 || /^<|<!doctype/i.test(body.trim())) {
    return `The server answered ${status}`;
  }
  return text;
}

const key = (row: { kind: string; id?: string; documentId?: string }) =>
  `${row.kind}:${row.id ?? row.documentId}`;

/**
 * Picking what to pay, confirming it, and posting it (SPEC §6).
 *
 * Three things pushed this onto the client, all of them about size. The
 * selection used to travel to the confirmation in the query string, and a
 * year of bills does not fit in a URL. The run used to post in one request,
 * and sixty consultants — each a transaction of its own, each several round
 * trips — is comfortably more than the sixty seconds a serverless function
 * gets; what the reader saw when it ran out was the app's own fault page.
 * And the amounts used to be matched to the ticked rows by position, so
 * unticking a row shifted every amount below it onto the wrong document.
 *
 * So: the selection is state, the confirmation is a request, and the run is a
 * loop of chunks that says how far it has got. Rows already paid are skipped
 * by the server, so a second press carries on rather than paying twice.
 */
export function PayPanel({
  rows,
  paymentAccounts,
  today,
  maxConsultants,
  truncated,
  browseLimit,
  baseCurrency,
  legacyCount,
}: {
  rows: PayableRow[];
  paymentAccounts: AccountOption[];
  today: string;
  maxConsultants: number;
  truncated: boolean;
  browseLimit: number;
  baseCurrency: string;
  legacyCount: number;
}) {
  const router = useRouter();

  const [ticked, setTicked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(rows.map((row) => [key(row), true])),
  );
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((row) => [key(row), row.balanceDue])),
  );

  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(today);
  const [paymentAccountId, setPaymentAccountId] = useState(paymentAccounts[0]?.id ?? "");
  const [reference, setReference] = useState("");

  const [running, setRunning] = useState(false);
  const [retrying, setRetrying] = useState(0);
  const [paid, setPaid] = useState<RunProgress["paid"]>([]);
  const [failed, setFailed] = useState<RunProgress["failed"]>([]);
  const [pending, setPending] = useState<PlannedLine[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const tickedCount = useMemo(
    () => rows.filter((row) => ticked[key(row)]).length,
    [rows, ticked],
  );

  const selectedLines = () =>
    rows
      .filter((row) => ticked[key(row)])
      .map((row) => ({
        kind: row.kind,
        documentId: row.id,
        amount: (amounts[key(row)] ?? row.balanceDue).trim(),
      }));

  const review = async () => {
    setPlanning(true);
    setError(null);
    try {
      const response = await fetch("/consultant-bills/pay/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lines: selectedLines() }),
      });
      if (!response.ok) throw new Error(readableError(await response.text(), response.status));
      setPlan((await response.json()) as Plan);
    } catch (caught) {
      setPlan(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPlanning(false);
    }
  };

  /**
   * One chunk, retried if the request itself fails.
   *
   * A chunk can die for reasons that have nothing to do with the run: a host
   * killing a function that ran long, a phone changing network. None of that
   * undoes what posted — each payment is its own transaction, stamped with
   * this run — so the right answer is to ask again.
   */
  const chunk = async (lines: PlannedLine[], id: string): Promise<RunProgress> => {
    let lastMessage = "The server could not be reached";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        setRetrying(attempt);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
      try {
        const response = await fetch("/consultant-bills/pay/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lines: lines.map((line) => ({
              kind: line.kind,
              documentId: line.documentId,
              amount: line.amount,
            })),
            date,
            paymentAccountId,
            reference,
            runId: id,
          }),
        });
        if (response.ok) {
          setRetrying(0);
          return (await response.json()) as RunProgress;
        }
        const message = readableError(await response.text(), response.status);
        if (response.status < 500) throw new Refused(message);
        lastMessage = message;
      } catch (caught) {
        if (caught instanceof Refused) throw caught;
        lastMessage = caught instanceof Error ? caught.message : String(caught);
      }
    }
    throw new Error(`${lastMessage} — nothing was lost; press Resume to carry on.`);
  };

  const run = async () => {
    if (!plan) return;
    setRunning(true);
    setError(null);

    // One id for the whole run, kept across a resume: it is what stops a
    // consultant already paid being paid again by the next chunk.
    const id = runId ?? newRunId();
    setRunId(id);

    let left =
      pending ?? plan.payable.flatMap((payment) => payment.lines);
    const done = new Set<string>();

    try {
      for (;;) {
        const progress = await chunk(left, id);

        if (progress.paid.length > 0) setPaid((current) => [...current, ...progress.paid]);
        if (progress.failed.length > 0) setFailed((current) => [...current, ...progress.failed]);

        // Whoever was tried — paid or refused — leaves the queue. Retrying a
        // refusal at the head of every chunk would spend the run failing in
        // the same way.
        for (const entry of [...progress.paid, ...progress.failed]) done.add(entry.vendorId);
        const vendorOf = new Map(
          plan.payable.flatMap((payment) =>
            payment.lines.map((line) => [key(line), payment.vendorId] as const),
          ),
        );
        left = left.filter((line) => !done.has(vendorOf.get(key(line)) ?? ""));
        setPending(left);

        if (progress.done || left.length === 0) {
          setFinished(true);
          break;
        }
        // A chunk that neither paid nor refused anybody made no progress, and
        // asking again would loop forever.
        if (progress.paid.length === 0 && progress.failed.length === 0) break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
      setRetrying(0);
      router.refresh();
    }
  };

  if (finished) {
    const total = paid.reduce((sum, entry) => sum + Number(entry.total), 0);
    return (
      <Alert tone="success">
        <strong className="block">
          {paid.length} consultant{paid.length === 1 ? "" : "s"} paid —{" "}
          {formatMoney(total.toFixed(2), baseCurrency)}.
        </strong>
        {failed.length > 0 ? (
          <span className="mt-1 block text-sm">
            {failed.length} could not be paid: {failed.map((entry) => `${entry.consultantName} — ${entry.reason}`).join("; ")}
          </span>
        ) : null}
        <span className="mt-2 block text-sm">
          <Link className="underline" href="/consultant-bills/pay">
            Back to what is still outstanding
          </Link>
        </span>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert tone="error">
          <strong className="block">{error}</strong>
          {paid.length > 0 ? (
            <span className="mt-1 block text-sm">
              {paid.length} consultant{paid.length === 1 ? "" : "s"} are already paid and will not
              be paid twice. Press Resume to carry on from where it stopped.
            </span>
          ) : null}
        </Alert>
      ) : null}

      {failed.length > 0 && !finished ? (
        <Alert tone="warning">
          <strong className="block">{failed.length} could not be paid.</strong>
          <ul className="mt-1 space-y-0.5 text-sm">
            {failed.slice(0, 5).map((entry) => (
              <li key={entry.vendorId}>
                {entry.consultantName} — {entry.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {plan ? (
        <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
          <h2 className="mb-1 text-sm font-semibold">
            {plan.payable.length} payment{plan.payable.length === 1 ? "" : "s"} to record
          </h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
            One per consultant.{" "}
            {plan.currency ? (
              <>Total {formatMoney(plan.total, plan.currency)}.</>
            ) : (
              <>The selection spans more than one currency, so there is no single total.</>
            )}
          </p>

          {plan.excluded.length > 0 ? (
            <Alert tone="warning">
              <strong>
                {plan.excluded.length} consultant{plan.excluded.length === 1 ? "" : "s"} left out:
              </strong>
              <ul className="ml-4 mt-1 list-disc">
                {plan.excluded.map((payment) => (
                  <li key={payment.vendorId}>{payment.reason}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {plan.payable.length > maxConsultants ? (
            <Alert tone="error">
              That is {plan.payable.length} consultants in one run; the limit is {maxConsultants}.
              Narrow the selection.
            </Alert>
          ) : null}

          <DataTable>
            <thead className="border-b border-slate-200 text-left dark:border-slate-700">
              <tr>
                <th className="py-2">Consultant</th>
                <th className="py-2">Settles</th>
                <th className="py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {plan.payable.map((payment) => (
                <tr
                  key={payment.vendorId}
                  className="border-b border-slate-100 dark:border-slate-800"
                >
                  <td className="py-2">{payment.consultantName}</td>
                  <td className="py-2">{payment.lines.map((line) => line.label).join(", ")}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatMoney(payment.total, payment.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>

          <div className="mt-3 flex flex-wrap gap-3">
            <Field label="Payment date">
              <Input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
              />
            </Field>
            <Field label="Paid from">
              <Select
                value={paymentAccountId}
                onChange={(event) => setPaymentAccountId(event.target.value)}
                required
              >
                {paymentAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" hint="Optional — the same on every payment in this run.">
              <Input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="e.g. Payroll 28 Aug"
              />
            </Field>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={run}
              disabled={
                running ||
                plan.payable.length === 0 ||
                plan.payable.length > maxConsultants ||
                !paymentAccountId ||
                !date
              }
            >
              {running
                ? retrying > 0
                  ? `Interrupted — trying again (${retrying} of 3)`
                  : `Paying… ${paid.length} of ${plan.payable.length} done`
                : paid.length > 0
                  ? `Resume — ${plan.payable.length - paid.length - failed.length} still to pay`
                  : `Record ${plan.payable.length} payment${plan.payable.length === 1 ? "" : "s"}`}
            </Button>
            {!running && paid.length === 0 ? (
              <Button type="button" variant="ghost" onClick={() => setPlan(null)}>
                Change the selection
              </Button>
            ) : null}
            {running ? (
              <span className="text-xs text-slate-500">
                Posted in batches so a long run cannot be cut off. Leave this page open.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {!plan ? (
        <>
          <DataTable>
            <thead className="border-b border-slate-200 text-left dark:border-slate-700">
              <tr>
                <th className="w-8 py-2" />
                <th className="py-2">Document</th>
                <th className="py-2">Consultant</th>
                <th className="py-2">Dated</th>
                <th className="py-2">Due</th>
                <th className="py-2 text-right">Outstanding</th>
                <th className="py-2 text-right">Paying</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = key(row);
                return (
                  <tr key={id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2">
                      <input
                        type="checkbox"
                        checked={ticked[id] ?? false}
                        onChange={(event) =>
                          setTicked((current) => ({ ...current, [id]: event.target.checked }))
                        }
                        aria-label={`Pay ${row.label}`}
                        className="h-4 w-4 rounded border-slate-300 accent-brand-600 dark:border-slate-600"
                      />
                    </td>
                    <td className="py-2">
                      <Link
                        className="underline decoration-dotted underline-offset-2"
                        href={row.href}
                      >
                        {row.label}
                      </Link>
                      {row.kind === "workOrder" ? (
                        // Said on the row rather than in a note nobody reads:
                        // these are the ones that posted on approval, and a
                        // reader needs to know why a work order is here.
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          work order
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2">{row.consultantName}</td>
                    <td className="py-2">{row.date}</td>
                    <td className="py-2 text-slate-500">{row.dueDate ?? "—"}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(row.balanceDue, row.currency)}
                    </td>
                    <td className="py-2 text-right">
                      {/* Keyed by document, not by position: the amounts used
                          to be matched to the ticked rows by their order on
                          screen, so unticking one shifted every amount below
                          it onto the wrong document.

                          The width lives on the wrapper, not on the Input:
                          `Input` carries w-full in its own base classes, and
                          two width utilities on one element are settled by
                          stylesheet order rather than by which was written
                          last. */}
                      <div className="ml-auto w-28">
                        <Input
                          inputMode="decimal"
                          value={amounts[id] ?? row.balanceDue}
                          onChange={(event) =>
                            setAmounts((current) => ({ ...current, [id]: event.target.value }))
                          }
                          aria-label={`Amount for ${row.label}`}
                          className="text-right"
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={review} disabled={planning || tickedCount === 0}>
              {planning ? "Checking…" : "Review payments"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setTicked(Object.fromEntries(rows.map((row) => [key(row), tickedCount === 0])))
              }
            >
              {tickedCount === 0 ? "Tick everything" : "Untick everything"}
            </Button>
            <span className="text-xs text-slate-500">
              {tickedCount} of {rows.length} ticked.
            </span>
          </div>

          {truncated ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Showing the oldest {browseLimit}. There is more outstanding than fits on one screen —
              filter by consultant or by date to reach the rest.
            </p>
          ) : null}
          <p className="text-xs text-slate-500">
            Up to {maxConsultants} consultants in one run. Books are {baseCurrency}; each document
            is paid in its own currency.
            {legacyCount > 0
              ? ` ${legacyCount} work order${legacyCount === 1 ? "" : "s"} raised under the earlier flow ${
                  legacyCount === 1 ? "is" : "are"
                } listed too — those posted on approval and are paid directly.`
              : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}

/**
 * An id for one run. `crypto.randomUUID` is not there on an http origin in
 * some browsers, and a run with no id is refused by the server, so there is a
 * plain fallback rather than a screen that cannot pay anybody.
 */
function newRunId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
