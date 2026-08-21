import type { VendorKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { money, type Money } from "@/lib/money";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { toBase } from "@/lib/ledger/fx";

/**
 * A/P aging (SPEC §12.6) — per vendor, and filterable by kind so the
 * consultant side and the regular-vendor side read separately. A user holding
 * only VENDORS sees the regular-vendor rows and nothing else (SPEC §2.1).
 *
 * As with A/R, buckets need a due date, so rows come from open documents and
 * the total is then checked against the A/P control account. The check only
 * applies when every kind is included — a filtered view is a subset of the
 * ledger balance by design.
 */

export type ApBuckets = {
  current: Money;
  days1to30: Money;
  days31to60: Money;
  days61to90: Money;
  days90plus: Money;
  total: Money;
};

export type ApRow = ApBuckets & {
  vendorId: string;
  vendorName: string;
  kind: VendorKind;
  documents: {
    id: string;
    type: "workOrder" | "bill";
    label: string;
    dueDate: Date;
    currency: string;
    balanceDue: Money;
    baseBalance: Money;
    daysOverdue: number;
  }[];
};

function empty(): ApBuckets {
  return {
    current: money(0),
    days1to30: money(0),
    days31to60: money(0),
    days61to90: money(0),
    days90plus: money(0),
    total: money(0),
  };
}

function addToBucket(buckets: ApBuckets, daysOverdue: number, amount: Money) {
  if (daysOverdue <= 0) buckets.current = buckets.current.plus(amount);
  else if (daysOverdue <= 30) buckets.days1to30 = buckets.days1to30.plus(amount);
  else if (daysOverdue <= 60) buckets.days31to60 = buckets.days31to60.plus(amount);
  else if (daysOverdue <= 90) buckets.days61to90 = buckets.days61to90.plus(amount);
  else buckets.days90plus = buckets.days90plus.plus(amount);
  buckets.total = buckets.total.plus(amount);
}

export async function apAging(options: {
  companyId: string;
  asOf: Date;
  /** Omit for everything; pass a kind to read one side of payables. */
  kind?: VendorKind | null;
}) {
  const vendorFilter = options.kind ? { kind: options.kind } : {};

  const [workOrders, bills] = await Promise.all([
    prisma.workOrder.findMany({
      where: {
        companyId: options.companyId,
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
        issueDate: { lte: options.asOf },
        vendor: vendorFilter,
      },
      include: { vendor: { select: { id: true, name: true, kind: true } } },
    }),
    prisma.expense.findMany({
      where: {
        companyId: options.companyId,
        kind: "BILL",
        status: { in: ["APPROVED", "PARTIALLY_PAID"] },
        date: { lte: options.asOf },
        vendor: vendorFilter,
      },
      include: { vendor: { select: { id: true, name: true, kind: true } } },
    }),
  ]);

  const byVendor = new Map<string, ApRow>();

  const add = (
    vendor: { id: string; name: string; kind: VendorKind },
    document: ApRow["documents"][number],
  ) => {
    let row = byVendor.get(vendor.id);
    if (!row) {
      row = { ...empty(), vendorId: vendor.id, vendorName: vendor.name, kind: vendor.kind, documents: [] };
      byVendor.set(vendor.id, row);
    }
    row.documents.push(document);
    addToBucket(row, document.daysOverdue, document.baseBalance);
  };

  const daysOverdue = (dueDate: Date) =>
    Math.floor((options.asOf.getTime() - dueDate.getTime()) / 86_400_000);

  for (const workOrder of workOrders) {
    const balanceDue = money(workOrder.balanceDue);
    if (balanceDue.lessThanOrEqualTo(0)) continue;
    add(workOrder.vendor, {
      id: workOrder.id,
      type: "workOrder",
      label: workOrder.workOrderNumber ?? "draft",
      dueDate: workOrder.dueDate,
      currency: workOrder.currency,
      balanceDue,
      baseBalance: toBase(balanceDue, workOrder.fxRate),
      daysOverdue: daysOverdue(workOrder.dueDate),
    });
  }

  for (const bill of bills) {
    const balanceDue = money(bill.balanceDue);
    if (balanceDue.lessThanOrEqualTo(0) || !bill.vendor) continue;
    const due = bill.dueDate ?? bill.date;
    add(bill.vendor, {
      id: bill.id,
      type: "bill",
      label: bill.description,
      dueDate: due,
      currency: bill.currency,
      balanceDue,
      baseBalance: toBase(balanceDue, bill.fxRate),
      daysOverdue: daysOverdue(due),
    });
  }

  const rows = [...byVendor.values()].sort((a, b) => a.vendorName.localeCompare(b.vendorName));

  const totals = empty();
  for (const row of rows) {
    totals.current = totals.current.plus(row.current);
    totals.days1to30 = totals.days1to30.plus(row.days1to30);
    totals.days31to60 = totals.days31to60.plus(row.days31to60);
    totals.days61to90 = totals.days61to90.plus(row.days61to90);
    totals.days90plus = totals.days90plus.plus(row.days90plus);
    totals.total = totals.total.plus(row.total);
  }

  const payableAccount = await prisma.account.findFirst({
    where: { companyId: options.companyId, systemKey: SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE },
    select: { id: true },
  });

  // A/P is credit-normal, so accountBalance already reports it positive.
  const controlBalance = payableAccount
    ? await accountBalance({
        companyId: options.companyId,
        accountId: payableAccount.id,
        asOf: options.asOf,
      })
    : money(0);

  // The total tying is not enough. Two equal and opposite errors against
  // different vendors cancel out in the control account, so the report can
  // look reconciled while the ledger says one vendor is owed money and another
  // is owed a negative amount. Comparing per party is what catches that.
  const perVendor = payableAccount
    ? await payableByVendor(options.companyId, payableAccount.id, options.asOf)
    : new Map<string, Money>();

  const documentByVendor = new Map(rows.map((row) => [row.vendorId, row.total]));
  const mismatchedIds = options.kind
    ? []
    : [...new Set([...perVendor.keys(), ...documentByVendor.keys()])].filter(
        (vendorId) =>
          !(perVendor.get(vendorId) ?? money(0)).equals(documentByVendor.get(vendorId) ?? money(0)),
      );

  // Names come from the vendor table, not from `rows`: the interesting case is
  // a vendor the ledger knows about but who has no open document, and that
  // vendor has no row to take a name from.
  const mismatchedNames = new Map(
    mismatchedIds.length === 0
      ? []
      : (
          await prisma.vendor.findMany({
            where: { id: { in: mismatchedIds }, companyId: options.companyId },
            select: { id: true, name: true },
          })
        ).map((vendor) => [vendor.id, vendor.name] as const),
  );

  const mismatchedVendors = mismatchedIds.map((vendorId) => ({
    vendorId,
    vendorName: mismatchedNames.get(vendorId) ?? "(unknown vendor)",
    ledger: perVendor.get(vendorId) ?? money(0),
    documents: documentByVendor.get(vendorId) ?? money(0),
  }));

  return {
    asOf: options.asOf,
    kind: options.kind ?? null,
    rows,
    totals,
    controlBalance,
    /** Only meaningful unfiltered: one kind is a subset of the control account. */
    tiesToLedger: options.kind ? null : totals.total.equals(controlBalance),
    /** Vendors whose ledger balance disagrees with their open documents. */
    mismatchedVendors,
  };
}

/** A/P balance per party, straight from the journal lines. */
async function payableByVendor(
  companyId: string,
  payableAccountId: string,
  asOf: Date,
): Promise<Map<string, Money>> {
  const grouped = await prisma.journalLine.groupBy({
    by: ["vendorId"],
    where: {
      accountId: payableAccountId,
      entry: { companyId, date: { lte: asOf } },
      vendorId: { not: null },
    },
    _sum: { debit: true, credit: true },
  });
  return new Map(
    grouped.map((row) => [
      row.vendorId as string,
      money(row._sum.credit ?? 0).minus(money(row._sum.debit ?? 0)),
    ]),
  );
}

export function apBucketValues(buckets: ApBuckets): Money[] {
  return [
    buckets.current,
    buckets.days1to30,
    buckets.days31to60,
    buckets.days61to90,
    buckets.days90plus,
  ];
}
