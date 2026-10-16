"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Field, Select } from "@/components/ui";

type AccountOption = { id: string; code: string; name: string };
type Category = { category: string; rowCount: number; accountId: string | null };
type CommitProgress = {
  imported: number;
  remaining: number;
  failed: { rowNumber: number; message: string }[];
  done: boolean;
};

/** The server's own no — not worth asking twice. */
class Refused extends Error {}

/**
 * What to show when the answer was not ours.
 *
 * A host that kills a function answers with its own page, and a wall of HTML
 * in a red box tells a reader nothing. The status is what matters.
 */
function readableError(body: string, status: number): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (status === 504 || /TIMEOUT/i.test(text)) {
    return "That batch of rows took too long and the server cut it off";
  }
  if (!text || text.length > 200 || /^<|<!doctype/i.test(body.trim())) {
    return `The server answered ${status}`;
  }
  return text;
}

/**
 * Mapping the sheet's categories, and running the commit (SPEC §8.3).
 *
 * The commit is a loop rather than one request, because each row is a real
 * posting and five hundred of them do not fit in the sixty seconds a
 * serverless function gets. Each call does a chunk and says what is left; this
 * keeps calling until it is done, and shows how far it has got — an import
 * that looks frozen for a minute is one somebody reloads halfway through.
 *
 * Rows already imported are skipped by the server, so a reload, a dropped
 * connection or a second press continues rather than duplicating.
 */
export function CommitPanel({
  batchId,
  categories,
  accounts,
  paymentAccounts,
  defaultPaymentAccountId,
  newVendorCount,
  importableCount,
  errorCount,
  currency,
  total,
}: {
  batchId: string;
  categories: Category[];
  accounts: AccountOption[];
  paymentAccounts: AccountOption[];
  defaultPaymentAccountId: string | null;
  newVendorCount: number;
  /**
   * Rows that will post once every category here has an account — the count
   * the button promises. Rows broken in some other way are not in it.
   */
  importableCount: number;
  errorCount: number;
  currency: string;
  total: string;
}) {
  const router = useRouter();
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      categories.map((entry) => [entry.category, entry.accountId ?? ""]),
    ),
  );
  const [paymentAccountId, setPaymentAccountId] = useState(defaultPaymentAccountId ?? "");
  const [createVendors, setCreateVendors] = useState(true);
  const [running, setRunning] = useState(false);
  const [imported, setImported] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [failed, setFailed] = useState<{ rowNumber: number; message: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(0);
  const [stalled, setStalled] = useState(false);
  const [done, setDone] = useState(false);

  const unmapped = categories.filter((entry) => !map[entry.category]);
  const ready = unmapped.length === 0 && paymentAccountId !== "" && importableCount > 0;

  /**
   * One chunk, retried if the request itself fails.
   *
   * A chunk can die for reasons that have nothing to do with the file: the
   * host killing a function that ran long, a phone changing network, a
   * gateway hiccup. None of that undoes what posted — rows are marked as they
   * go — so the right answer is to ask again rather than to stop a job that
   * is half done and make somebody work out where it got to.
   */
  const chunk = async (): Promise<CommitProgress> => {
    let lastMessage = "The server could not be reached";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        setRetrying(attempt);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
      try {
        const response = await fetch(`/expenses/import/${batchId}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountMap: map, paymentAccountId, createVendors }),
        });
        if (response.ok) {
          setRetrying(0);
          return (await response.json()) as CommitProgress;
        }
        const message = readableError(await response.text(), response.status);
        // A refusal is the server's answer and asking again will not change
        // it; anything else is the plumbing, and worth another go.
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
    setRunning(true);
    setError(null);
    setStalled(false);
    setFailed([]);
    // Resuming continues the count rather than starting it again: what is
    // recorded is recorded, whatever happened to the connection.
    let total = imported;
    try {
      // Keep asking for another chunk until the server says it is finished.
      for (;;) {
        const progress = await chunk();

        total += progress.imported;
        setImported(total);
        setRemaining(progress.remaining);
        if (progress.failed.length > 0) {
          setFailed((current) => [...current, ...progress.failed]);
        }
        // A chunk that neither imported nor refused a row made no progress at
        // all, and asking again would loop forever.
        if (progress.done || (progress.imported === 0 && progress.failed.length === 0)) {
          setDone(progress.done);
          break;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStalled(true);
    } finally {
      setRunning(false);
      setRetrying(0);
      router.refresh();
    }
  };

  if (done) {
    return (
      <Alert tone="success">
        <strong className="block">Imported {imported} expenses.</strong>
        <span className="mt-1 block text-sm">
          They are recorded and posted. {errorCount > 0 ? `${errorCount} rows were left behind — download the rejects below, fix them and upload again.` : ""}
        </span>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="mb-1 text-sm font-semibold">Which account is each category?</h2>
        <p className="mb-3 text-xs text-slate-500">
          Chosen once. The answer is remembered against the account, so the next sheet that says
          the same word maps itself.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {categories.map((entry) => (
            <Field
              key={entry.category}
              label={entry.category || "(blank)"}
              hint={`${entry.rowCount} row${entry.rowCount === 1 ? "" : "s"}`}
            >
              <Select
                value={map[entry.category] ?? ""}
                onChange={(event) =>
                  setMap((current) => ({ ...current, [entry.category]: event.target.value }))
                }
              >
                <option value="">Select an account…</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} — {account.name}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      </div>

      <Field
        label="Paid from"
        hint="Every row posts as paid out of this account. The sheet has no payment column, so one answer covers the file."
      >
        <Select
          value={paymentAccountId}
          onChange={(event) => setPaymentAccountId(event.target.value)}
        >
          <option value="">Select an account…</option>
          {paymentAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
        </Select>
      </Field>

      {newVendorCount > 0 ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={createVendors}
            onChange={(event) => setCreateVendors(event.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>
            Create {newVendorCount} new vendor{newVendorCount === 1 ? "" : "s"} for payees that are
            not on file yet.
            <span className="block text-xs text-slate-500">
              Unticked, those rows still import — the expense simply has no vendor on it.
            </span>
          </span>
        </label>
      ) : null}

      {error ? (
        <Alert tone="error">
          <strong className="block">{error}</strong>
          <span className="mt-1 block text-sm">
            {imported > 0 ? `${imported} expenses are already recorded and will not be imported twice. ` : ""}
            Press Resume to carry on from where it stopped.
          </span>
        </Alert>
      ) : null}

      {failed.length > 0 ? (
        <Alert tone="warning">
          <strong className="block">{failed.length} rows were refused.</strong>
          <ul className="mt-1 space-y-0.5 text-sm">
            {failed.slice(0, 5).map((row) => (
              <li key={row.rowNumber}>
                Row {row.rowNumber}: {row.message}
              </li>
            ))}
          </ul>
          {failed.length > 5 ? (
            <span className="mt-1 block text-sm">and {failed.length - 5} more.</span>
          ) : null}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4 dark:border-slate-800">
        <Button type="button" onClick={run} disabled={!ready || running}>
          {running
            ? retrying > 0
              ? `Interrupted — trying again (${retrying} of 3)`
              : `Importing… ${imported} done${remaining !== null ? `, ${remaining} to go` : ""}`
            : stalled
              ? `Resume — ${remaining ?? 0} still to import`
              : `Import ${importableCount} expense${importableCount === 1 ? "" : "s"} · ${currency} ${total}`}
        </Button>
        {!ready && !running ? (
          <span className="text-xs text-slate-500">
            {unmapped.length > 0
              ? `Map ${unmapped.length} more categor${unmapped.length === 1 ? "y" : "ies"} first.`
              : importableCount === 0
                ? "No rows are ready to import."
                : "Choose the account the money came out of."}
          </span>
        ) : null}
      </div>
    </div>
  );
}
