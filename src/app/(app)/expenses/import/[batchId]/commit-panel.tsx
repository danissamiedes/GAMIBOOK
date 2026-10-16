"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Field, Select } from "@/components/ui";

type AccountOption = { id: string; code: string; name: string };
type Category = { category: string; rowCount: number; accountId: string | null };

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
  const [done, setDone] = useState(false);

  const unmapped = categories.filter((entry) => !map[entry.category]);
  const ready = unmapped.length === 0 && paymentAccountId !== "" && importableCount > 0;

  const run = async () => {
    setRunning(true);
    setError(null);
    setFailed([]);
    let total = 0;
    try {
      // Keep asking for another chunk until the server says it is finished.
      for (;;) {
        const response = await fetch(`/expenses/import/${batchId}/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountMap: map, paymentAccountId, createVendors }),
        });
        if (!response.ok) {
          setError(await response.text());
          break;
        }
        const progress: {
          imported: number;
          remaining: number;
          failed: { rowNumber: number; message: string }[];
          done: boolean;
        } = await response.json();

        total += progress.imported;
        setImported(total);
        setRemaining(progress.remaining);
        if (progress.failed.length > 0) {
          setFailed((current) => [...current, ...progress.failed]);
        }
        // A chunk that imported nothing and has rows left would loop forever.
        if (progress.done || progress.imported === 0) {
          setDone(progress.done);
          break;
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
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

      {error ? <Alert tone="error">{error}</Alert> : null}

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
            ? `Importing… ${imported} done${remaining !== null ? `, ${remaining} to go` : ""}`
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
