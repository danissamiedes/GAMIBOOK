"use client";

import { useMemo, useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { LINE_GRID_HINT, useLineGrid } from "@/components/line-grid";

type AccountOption = { id: string; code: string; name: string };
type ItemOption = {
  id: string;
  name: string;
  defaultRate: string | null;
  accountId: string | null;
};

export type Line = {
  itemId: string;
  description: string;
  quantity: string;
  rate: string;
  accountId: string;
};

/**
 * Line editor for invoices and work orders (SPEC §8.1: description, quantity
 * and rate are the three fields that matter). Keyboard-first — Tab from the
 * last field adds a row — with a running total, because a bookkeeper should
 * see the document total while typing.
 */
export function DocumentLineEditor({
  accounts,
  items = [],
  accountLabel = "Account",
  currency,
  defaultAccountId,
  initialLines,
}: {
  accounts: AccountOption[];
  items?: ItemOption[];
  accountLabel?: string;
  currency: string;
  defaultAccountId?: string;
  /** Existing lines, when editing. Omitted on a new document. */
  initialLines?: Line[];
}) {
  const blank = (): Line => ({
    itemId: "",
    description: "",
    quantity: "1",
    rate: "",
    accountId: defaultAccountId ?? "",
  });

  // Seeded once. The editor owns its rows from here, and re-seeding on every
  // render would overwrite what someone is in the middle of typing. When the
  // caller needs to start it over on a different document, it gives the
  // component a different `key`.
  const [lines, setLines] = useState<Line[]>(
    initialLines && initialLines.length > 0 ? initialLines : [blank()],
  );
  const { gridProps, addRow, removeRow } = useLineGrid({
    setLines,
    blank,
    minLines: 1,
  });

  const update = (index: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  const applyItem = (index: number, itemId: string) => {
    const item = items.find((candidate) => candidate.id === itemId);
    update(index, {
      itemId,
      ...(item
        ? {
            description: item.name,
            rate: item.defaultRate ?? "",
            accountId: item.accountId ?? lines[index].accountId,
          }
        : {}),
    });
  };

  const parse = (value: string) => {
    const parsed = Number.parseFloat(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const amounts = useMemo(
    () => lines.map((line) => parse(line.quantity) * parse(line.rate)),
    [lines],
  );
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  const fmt = (value: number) =>
    value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto" {...gridProps}>
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              {items.length > 0 ? <th className="pb-2">Item</th> : null}
              <th className="pb-2">Description</th>
              <th className="pb-2 w-24 text-right">Quantity</th>
              <th className="pb-2 w-32 text-right">Rate</th>
              <th className="pb-2 pr-2 w-36 text-right">Amount</th>
              <th className="pb-2">{accountLabel}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={index}>
                {items.length > 0 ? (
                  <td className="py-1 pr-2">
                    <Select
                      value={line.itemId}
                      onChange={(event) => applyItem(index, event.target.value)}
                    >
                      <option value="">—</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                ) : null}
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-description`}
                    value={line.description}
                    onChange={(event) =>
                      update(index, { description: event.target.value })
                    }
                    required
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-quantity`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.quantity}
                    onChange={(event) =>
                      update(index, { quantity: event.target.value })
                    }
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    name={`line-${index}-rate`}
                    inputMode="decimal"
                    className="text-right"
                    value={line.rate}
                    onChange={(event) =>
                      update(index, { rate: event.target.value })
                    }
                  />
                </td>
                <td className="py-1 pr-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {fmt(amounts[index])}
                </td>
                <td className="py-1 pr-2">
                  <Select
                    name={`line-${index}-accountId`}
                    value={line.accountId}
                    onChange={(event) =>
                      update(index, { accountId: event.target.value })
                    }
                    required
                  >
                    <option value="">Select…</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} — {account.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="py-1 text-right">
                  {lines.length > 1 ? (
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
            <tr className="border-t border-slate-200 dark:border-slate-800">
              <td className="pt-2" colSpan={items.length > 0 ? 4 : 3}>
                <Button type="button" variant="secondary" onClick={addRow}>
                  Add line
                </Button>
              </td>
              <td className="pt-2 text-right font-semibold tabular-nums">
                {currency} {fmt(total)}
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-slate-500">{LINE_GRID_HINT}</p>
      <input type="hidden" name="lineCount" value={lines.length} />
    </div>
  );
}
