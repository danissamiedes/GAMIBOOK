import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { computeWorkOrderLine } from "@/lib/payables/work-orders";
import { renderInvoicePdf, renderWorkOrderPdf, renderReceiptPdf, cachedPdf, slug, brandingFor } from "@/lib/pdf/render";
import { pdfSafe, renderReportPdf } from "@/lib/pdf/report";
import { profitAndLossByMonth } from "@/lib/reports/profit-loss-by-month";
import { resetStorage, storage, storageKeys } from "@/lib/storage";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase, approveAsLegacyWorkOrder } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/** SPEC §11. A PDF is a cache: regenerable from the document at any time. */
describe("document PDFs", () => {
  let fixture: Fixture;
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = mkdtempSync(path.join(tmpdir(), "ledger-pdf-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    resetStorage();

    fixture = await makeCompanyWithChart("PDF Co", "PHP");
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: {
        addressLine1: "12 Ayala Avenue",
        city: "Makati",
        country: "Philippines",
        email: "accounts@example.test",
        taxNumber: "123-456-789",
        footerText: "Payment to BDO 1234-5678. Thank you.",
      },
    });
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await resetDatabase();
    await prisma.$disconnect();
  });

  const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString() === "%PDF-";

  it("renders an issued invoice, named per the spec", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Cebu Retail Group" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Consulting", quantity: "2", rate: "25000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });

    const pdf = await renderInvoicePdf(fixture.company.id, invoice.id);
    expect(isPdf(pdf.bytes)).toBe(true);
    expect(pdf.bytes.length).toBeGreaterThan(1000);
    expect(pdf.filename).toBe("Invoice-INV1001-cebu-retail-group.pdf");
  });

  it("marks a draft invoice as a draft in its filename", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "100.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    const pdf = await renderInvoicePdf(fixture.company.id, invoice.id);
    expect(pdf.filename).toBe("Invoice-DRAFT-acme.pdf");
    expect(isPdf(pdf.bytes)).toBe(true);
  });

  it("renders a work order, including a negative deduction line", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "John Rex Meraveles",
    });
    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 7, 15)),
        dueDate: new Date(Date.UTC(2026, 7, 30)),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Consultation for period 072626-081026",
              quantity: "0.5",
              rate: "16000.00",
              amount: computeWorkOrderLine({ quantity: "0.5", rate: "16000.00" }),
              accountId: fixture.code("5000").id,
            },
            {
              lineNumber: 2,
              description: "Cash Advances",
              quantity: "1",
              rate: "-3000.00",
              amount: computeWorkOrderLine({ quantity: "1", rate: "-3000.00" }),
              accountId: fixture.code("1200").id,
            },
          ],
        },
      },
    });
    await approveAsLegacyWorkOrder(fixture.company.id, workOrder.id);

    const pdf = await renderWorkOrderPdf(fixture.company.id, workOrder.id);
    expect(isPdf(pdf.bytes)).toBe(true);
    expect(pdf.filename).toBe("WorkOrder-WO1001-john-rex-meraveles.pdf");
  });

  it("gives a draft work order a collision-proof filename", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", { name: "Abigail" });
    const first = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 7, 15)),
        dueDate: new Date(Date.UTC(2026, 7, 30)),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "A",
              quantity: "1",
              rate: "100",
              amount: "100.00",
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    const second = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 7, 15)),
        dueDate: new Date(Date.UTC(2026, 7, 30)),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "B",
              quantity: "1",
              rate: "100",
              amount: "100.00",
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });

    // Two drafts for the same consultant must not produce the same attachment
    // name, or a bulk email silently drops one of them.
    const a = await renderWorkOrderPdf(fixture.company.id, first.id);
    const b = await renderWorkOrderPdf(fixture.company.id, second.id);
    expect(a.filename).not.toBe(b.filename);
    expect(a.filename).toMatch(/^WorkOrder-DRAFT-[a-z0-9]{6}-abigail\.pdf$/);
  });

  it("renders a payment receipt", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "5000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
    const { payment } = await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 3, 1)),
      amount: "5000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      reference: "TX-9001",
      applications: [{ invoiceId: invoice.id, amountApplied: "5000.00" }],
    });

    const pdf = await renderReceiptPdf(fixture.company.id, payment.id);
    expect(isPdf(pdf.bytes)).toBe(true);
    expect(pdf.filename).toBe("Receipt-TX-9001-acme.pdf");
  });

  it("caches to storage and regenerates on demand", async () => {
    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "100.00", incomeAccountId: fixture.code("4000").id },
      ],
    });

    const key = storageKeys.documentPdf(fixture.company.id, "invoice", invoice.id);
    expect(await storage().exists(key)).toBe(false);

    const first = await cachedPdf(fixture.company.id, "invoice", invoice.id);
    expect(await storage().exists(key)).toBe(true);

    // Served from cache, and identical.
    const second = await cachedPdf(fixture.company.id, "invoice", invoice.id);
    expect(second.bytes.length).toBe(first.bytes.length);
    expect(second.filename).toBe(first.filename);

    // Deleting the cached object loses nothing: it renders again.
    await storage().delete(key);
    const third = await cachedPdf(fixture.company.id, "invoice", invoice.id);
    expect(third.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("renders even when the branding logo is missing from storage", async () => {
    await prisma.company.update({
      where: { id: fixture.company.id },
      data: { logoFileKey: "companies/none/branding/missing.png" },
    });
    const customer = await makeCustomer(fixture.company.id, { name: "Acme" });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "100.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    // A missing logo must never stop an invoice going out.
    const pdf = await renderInvoicePdf(fixture.company.id, invoice.id);
    expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("slugs names safely for filenames", () => {
    expect(slug("Cebu Retail Group")).toBe("cebu-retail-group");
    expect(slug("O'Brien & Sons, Inc.")).toBe("o-brien-sons-inc");
    expect(slug("   ")).toBe("unnamed");
  });
});

/**
 * SPEC §12.1: the report PDFs. The monthly P&L is the awkward one — a
 * column per month, which is why it is the only report set sideways.
 */
describe("the monthly P&L as a PDF", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("PDF Co", "PHP");
  });

  const isPdf = (bytes: Buffer) => bytes.subarray(0, 5).toString() === "%PDF-";

  const render = async (from: Date, to: Date) => {
    const report = await profitAndLossByMonth({ companyId: fixture.company.id, from, to });
    const bytes = await renderReportPdf(await brandingFor(fixture.company.id), {
      title: "Profit & Loss by month",
      subtitle: "test",
      landscape: true,
      columns: [
        { label: "Account", width: 150 },
        ...report.months.map((month) => ({ label: month.label, align: "right" as const })),
        { label: "Total", align: "right" as const },
      ],
      rows: report.sections.flatMap((section) =>
        section.rows.map((row) => [
          `${row.code} ${row.name}`,
          ...row.months.map((amount) => amount.toFixed(2)),
          row.total.toFixed(2),
        ]),
      ),
      totalRow: [
        "Net income",
        ...report.netIncome.months.map((amount) => amount.toFixed(2)),
        report.netIncome.total.toFixed(2),
      ],
    });
    return { bytes, report };
  };

  it("renders a full year — thirteen columns — on one sideways page", async () => {
    const { bytes, report } = await render(
      new Date(Date.UTC(2026, 0, 1)),
      new Date(Date.UTC(2026, 11, 31)),
    );
    expect(report.months).toHaveLength(12);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders a part month too, which is the case that breaks the arithmetic", async () => {
    const { bytes, report } = await render(
      new Date(Date.UTC(2026, 0, 15)),
      new Date(Date.UTC(2026, 2, 10)),
    );
    expect(report.months.some((month) => !month.whole)).toBe(true);
    expect(isPdf(bytes)).toBe(true);
  });
});

describe("what the built-in PDF font cannot draw", () => {
  // No font is registered, so anything outside the standard encoding is not
  // drawn at all — silently. A part-month heading came out as
  // "OCT 1OCT 20, 2026", its en dash simply gone.
  it("turns the dashes and quotes a document picks up into plain ones", () => {
    expect(pdfSafe("Oct 1\u2013Oct 20, 2026")).toBe("Oct 1-Oct 20, 2026");
    expect(pdfSafe("\u2014 and \u2010")).toBe("- and -");
    expect(pdfSafe("O\u2019Brien said \u201cno\u201d")).toBe(`O'Brien said "no"`);
    expect(pdfSafe("Wait\u2026")).toBe("Wait...");
  });

  it("keeps what the font can draw, accents and the middle dot included", () => {
    expect(pdfSafe("Ni\u00f1o \u00b7 PHP \u00a31,000")).toBe("Ni\u00f1o \u00b7 PHP \u00a31,000");
  });

  it("marks anything else rather than dropping it without trace", () => {
    expect(pdfSafe("\u4f60\u597d")).toBe("??");
  });
});
