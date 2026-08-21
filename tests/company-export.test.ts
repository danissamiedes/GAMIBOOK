import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { postJournalEntry } from "@/lib/ledger/post";
import { issueInvoice } from "@/lib/invoices/service";
import { buildCompanyExport } from "@/lib/exports/company-export";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/** Parses a CSV the way a spreadsheet would, minus the quoting edge cases. */
function parse(csv: string): string[][] {
  return csv
    .replace(/^﻿/, "")
    .split("\r\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const cells: string[] = [];
      let cell = "";
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (quoted) {
          if (char === '"' && line[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else if (char === '"') quoted = false;
          else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") {
          cells.push(cell);
          cell = "";
        } else cell += char;
      }
      cells.push(cell);
      return cells;
    });
}

/**
 * SPEC §13 — "the user must never feel their books are trapped in this app".
 * The test of that is not that a file downloads: it is that the ledger inside
 * it still balances and still ties to the documents beside it.
 */
describe("full data export", () => {
  let fixture: Fixture;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Ábigail & Co, Ltd.", "PHP");

    await postJournalEntry({
      companyId: fixture.company.id,
      date: new Date(Date.UTC(2026, 2, 1)),
      memo: 'Opening float, "petty cash"',
      sourceType: "MANUAL",
      role: "OWNER",
      lines: [
        { accountId: fixture.code("1000").id, debit: "100000.00" },
        { accountId: fixture.code("3000").id, credit: "100000.00" },
      ],
    });

    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail, Inc.",
    });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        {
          description: 'Consulting, "March"',
          quantity: "2",
          rate: "25000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });
    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
      role: "OWNER",
    });
    await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Abigail Bautista",
    });
  });

  it("packs every table, and the ledger inside still balances", async () => {
    const archive = await buildCompanyExport(fixture.company.id);
    const files = unzipSync(archive.bytes);
    const read = (name: string) => parse(strFromU8(files[name]));

    expect(Object.keys(files)).toContain("README.txt");
    for (const name of [
      "company.csv",
      "accounts.csv",
      "journal-entries.csv",
      "journal-lines.csv",
      "customers.csv",
      "vendors.csv",
      "invoices.csv",
      "invoice-lines.csv",
      "customer-payments.csv",
      "work-orders.csv",
      "work-order-lines.csv",
      "expenses.csv",
      "bill-payments.csv",
      "time-entries.csv",
      "sales-orders.csv",
      "audit-log.csv",
    ]) {
      expect(Object.keys(files)).toContain(name);
    }

    // The claim the README makes about itself: journal-lines.csv is the books.
    const lines = read("journal-lines.csv");
    const header = lines[0];
    const debitAt = header.indexOf("debit");
    const creditAt = header.indexOf("credit");
    const totals = lines.slice(1).reduce(
      (running, row) => ({
        debit: running.debit + Number(row[debitAt]),
        credit: running.credit + Number(row[creditAt]),
      }),
      { debit: 0, credit: 0 },
    );
    expect(totals.debit).toBeCloseTo(totals.credit, 2);
    expect(totals.debit).toBeCloseTo(150000, 2); // 100,000 opening + 50,000 invoice

    // Documents tie to the ledger they came from.
    const invoices = read("invoices.csv");
    expect(invoices).toHaveLength(2);
    expect(invoices[1][invoices[0].indexOf("total")]).toBe("50000.00");
    expect(invoices[1][invoices[0].indexOf("customer")]).toBe(
      "Cebu Retail, Inc.",
    );
  });

  it("quotes commas and quotes rather than corrupting the row", async () => {
    const archive = await buildCompanyExport(fixture.company.id);
    const files = unzipSync(archive.bytes);

    // "Cebu Retail, Inc." would split into two cells unquoted.
    const customers = parse(strFromU8(files["customers.csv"]));
    expect(customers[1][0]).toBe("Cebu Retail, Inc.");

    const entries = parse(strFromU8(files["journal-entries.csv"]));
    const memoAt = entries[0].indexOf("memo");
    expect(
      entries.some((row) => row[memoAt] === 'Opening float, "petty cash"'),
    ).toBe(true);

    const invoiceLines = parse(strFromU8(files["invoice-lines.csv"]));
    expect(invoiceLines[1][invoiceLines[0].indexOf("description")]).toBe(
      'Consulting, "March"',
    );
  });

  it("starts each CSV with a BOM so Excel reads the accents", async () => {
    const archive = await buildCompanyExport(fixture.company.id);
    const files = unzipSync(archive.bytes);
    // Checked on the bytes, not the decoded string: TextDecoder swallows a
    // leading BOM, so strFromU8 would report success either way.
    const bytes = files["vendors.csv"];
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(strFromU8(bytes)).toContain("Abigail Bautista");
  });

  it("names the file after the company and the day", async () => {
    const archive = await buildCompanyExport(fixture.company.id);
    // Punctuation in the company name must not escape into the filename.
    expect(archive.filename).toMatch(
      /^abigail-co-ltd-export-\d{4}-\d{2}-\d{2}\.zip$/,
    );
  });

  it("exports one company's books and not the other's", async () => {
    const other = await makeCompanyWithChart("Northbridge", "USD");
    await makeCustomer(other.company.id, { name: "Someone Else Entirely" });

    const archive = await buildCompanyExport(fixture.company.id);
    const files = unzipSync(archive.bytes);
    expect(strFromU8(files["customers.csv"])).not.toContain(
      "Someone Else Entirely",
    );
  });
});
