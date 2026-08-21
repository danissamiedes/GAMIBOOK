"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { LINE_GRID_HINT, useLineGrid } from "@/components/line-grid";

type AccountOption = { id: string; code: string; name: string };

type Line = {
  accountId: string;
  description: string;
  debit: string;
  credit: string;
};

const EMPTY: Line = { accountId: "", description: "", debit: "", credit: "" };

/**
 * Manual journal entry lines. Keyboard-first, with a running total that shows
 * the difference before the server rejects it — the balance rule is enforced
 * on the server and in the database, but a bookkeeper should see the problem
 * while typing, not after submitting.
 */
export function JournalLineEditor({ accounts }: { accounts: AccountOption[] }) {
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }, { ...EMPTY }]);
  // Two lines is the floor: an entry with one line cannot balance (SPEC §4.2).
  const { gridProps, addRow, removeRow } = useLineGrid({
    setLines,
    blank: () => ({ ...EMPTY }),
    minLines: 2,
  });

  const update = (index: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  const totals = useMemo(() => {
    const parse = (value: string) => {
      const cleaned = value.replace(/,/g, "").trim();
      const parsed = Number.parseFloat(cleaned);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const debit = lines.reduce((total, line) => total + parse(line.debit), 0);
    const credit = lines.reduce((total, line) => total + parse(line.credit), 0);
    return { debit, credit, difference: debit - credit };
  }, [lines]);

  const fmt = (value: number) =>
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto" {...gridProps}>
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-2">Account</th>
              <th className="pb-2">Description</th>
              <th className="pb-2 text-right">Debit</th>
              <th className="pb-2 text-right">Credit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="py-1 pr-2">
                  <Select
                    name={`line-${index}-accountId`}
                    value={line.accountId}
                    onChange={(event) =>
                      update(index, { accountId: event.target.value })
                    }
                  >
                    <option value="">Select an account…</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-description`}
                    value={line.description}
                    onChange={(event) =>
                      update(index, { description: event.target.value })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-debit`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.debit}
                    onChange={(event) =>
                      update(index, { debit: event.target.value, credit: "" })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-credit`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.credit}
                    onChange={(event) =>
                      update(index, { credit: event.target.value, debit: "" })
                    }
                  />
                </td>
                <td className="py-1 text-right">
                  {lines.length > 2 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => removeRow(index)}
                    >
                      ×
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-200 text-sm dark:border-slate-800">
              <td className="pt-2" colSpan={2}>
                <Button type="button" variant="secondary" onClick={addRow}>
                  Add line
                </Button>
              </td>
              <td className="pt-2 text-right font-medium">
                {fmt(totals.debit)}
              </td>
              <td className="pt-2 text-right font-medium">
                {fmt(totals.credit)}
              </td>
              <td />
            </tr>
            <tr>
              <td
                colSpan={2}
                className="pt-1 text-right text-xs text-slate-500"
              >
                Difference
              </td>
              <td
                colSpan={2}
                className={`pt-1 text-right text-sm font-semibold ${
                  Math.abs(totals.difference) < 0.005
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                }`}
              >
                {fmt(totals.difference)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-slate-500">{LINE_GRID_HINT}</p>
      <input type="hidden" name="lineCount" value={lines.length} />
    </div>
  );
}
