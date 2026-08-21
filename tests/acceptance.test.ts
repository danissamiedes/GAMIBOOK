import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { issueInvoice } from "@/lib/invoices/service";
import { recordPayment } from "@/lib/invoices/payments";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { recordBillPayment } from "@/lib/payables/bill-payments";
import { balanceSheet } from "@/lib/reports/balance-sheet";
import { profitAndLoss } from "@/lib/reports/profit-loss";
import {
  accountDetail,
  sourceDocumentHref,
} from "@/lib/reports/general-ledger";
import { renderInvoicePdf, renderWorkOrderPdf } from "@/lib/pdf/render";
import { sendEmail } from "@/lib/email/send";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { money } from "@/lib/money";
import {
  makeCompanyWithChart,
  makeCustomer,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * The acceptance criteria in SPEC §15, as tests.
 *
 * The unit suites each prove one behaviour in isolation; these walk a document
 * from creation to settlement and check the *reports* after every step, which
 * is how the spec words the criteria and the only way to catch a step that is
 * individually right but leaves the books wrong in sequence.
 */
describe("SPEC §15 acceptance", () => {
  let fixture: Fixture;

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("Acceptance Co", "PHP");
  });

  /** A/R and A/P straight off the Balance Sheet, as a reader would read them. */
  async function sheet(asOf: Date) {
    const bs = await balanceSheet({ companyId: fixture.company.id, asOf });
    const find = (systemKey: string) =>
      [...bs.assets.current.rows, ...bs.liabilities.current.rows].find(
        (row) => row.accountId === fixture.system(systemKey).id,
      );
    return {
      balanced: bs.balanced,
      difference: bs.difference,
      receivable: find(SYSTEM_ACCOUNTS.ACCOUNTS_RECEIVABLE)?.amount ?? money(0),
      payable: find(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE)?.amount ?? money(0),
      netIncome: bs.equity.netIncome,
    };
  }

  it("§15.3 — an invoice: created, PDF, emailed, part-paid, paid; A/R right at each step", async () => {
    const asOf = new Date(Date.UTC(2026, 5, 30));
    const customer = await makeCustomer(fixture.company.id, {
      name: "Cebu Retail",
    });

    const draft = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      issueDate: new Date(Date.UTC(2026, 5, 1)),
      lines: [
        {
          description: "Consulting",
          quantity: "1",
          rate: "50000.00",
          incomeAccountId: fixture.code("4000").id,
        },
      ],
    });

    // A draft posts nothing at all.
    let view = await sheet(asOf);
    expect(view.receivable.toFixed(2)).toBe("0.00");
    expect(view.balanced).toBe(true);

    await issueInvoice({
      companyId: fixture.company.id,
      invoiceId: draft.id,
      role: "OWNER",
    });
    view = await sheet(asOf);
    expect(view.receivable.toFixed(2)).toBe("50000.00");
    expect(view.netIncome.toFixed(2)).toBe("50000.00");
    expect(view.balanced).toBe(true);

    // Previewable as a PDF, and emailable — neither touches the ledger.
    const pdf = await renderInvoicePdf(fixture.company.id, draft.id);
    expect(pdf.bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    const sent = await sendEmail({
      companyId: fixture.company.id,
      email: {
        cc: [],
        to: ["billing@example.test"],
        subject: "Invoice INV1001",
        body: "Attached.",
        attachments: [
          {
            filename: pdf.filename,
            content: pdf.bytes,
            contentType: "application/pdf",
          },
        ],
        relatedType: "Invoice",
        relatedId: draft.id,
      },
    });
    expect(sent.status).toBe("SENT");
    expect((await sheet(asOf)).receivable.toFixed(2)).toBe("50000.00");

    // Part paid.
    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 5, 15)),
      amount: "20000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: draft.id, amountApplied: "20000.00" }],
      role: "OWNER",
    });
    view = await sheet(asOf);
    expect(view.receivable.toFixed(2)).toBe("30000.00");
    expect(view.balanced).toBe(true);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } }))
        .status,
    ).toBe("PARTIALLY_PAID");

    // Settled.
    await recordPayment({
      companyId: fixture.company.id,
      customerId: customer.id,
      date: new Date(Date.UTC(2026, 5, 20)),
      amount: "30000.00",
      currency: "PHP",
      depositAccountId: fixture.code("1000").id,
      applications: [{ invoiceId: draft.id, amountApplied: "30000.00" }],
      role: "OWNER",
    });
    view = await sheet(asOf);
    expect(view.receivable.toFixed(2)).toBe("0.00");
    expect(view.balanced).toBe(true);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } }))
        .status,
    ).toBe("PAID");

    // Revenue stayed put while the receivable drained into cash.
    const pl = await profitAndLoss({
      companyId: fixture.company.id,
      from: new Date(Date.UTC(2026, 5, 1)),
      to: asOf,
    });
    expect(pl.netIncome.toFixed(2)).toBe("50000.00");
  });

  it("§15.5 — a work order: created, emailed, approved, paid; A/P right at each step", async () => {
    const asOf = new Date(Date.UTC(2026, 5, 30));
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Abigail Bautista",
      email: "abigail@example.test",
    });

    const workOrder = await prisma.workOrder.create({
      data: {
        companyId: fixture.company.id,
        vendorId: consultant.id,
        issueDate: new Date(Date.UTC(2026, 5, 1)),
        dueDate: new Date(Date.UTC(2026, 5, 30)),
        currency: "PHP",
        lines: {
          create: [
            {
              lineNumber: 1,
              description: "Fieldwork, 10 days",
              quantity: "10",
              rate: "2000.00",
              amount: "20000.00",
              accountId: fixture.code("6000").id,
            },
            {
              lineNumber: 2,
              description: "Cash advance recovered",
              quantity: "1",
              rate: "-3000.00",
              amount: "-3000.00",
              accountId: fixture.code("6000").id,
            },
          ],
        },
      },
    });

    // A draft is not a payable, and has no number yet.
    expect((await sheet(asOf)).payable.toFixed(2)).toBe("0.00");
    expect(workOrder.workOrderNumber).toBeNull();

    // Emailable as a draft — that is the point of sending it for agreement.
    const pdf = await renderWorkOrderPdf(fixture.company.id, workOrder.id);
    expect(pdf.bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    const sent = await sendEmail({
      companyId: fixture.company.id,
      email: {
        cc: [],
        to: [consultant.email!],
        subject: "Your work order",
        body: "Attached.",
        attachments: [
          {
            filename: pdf.filename,
            content: pdf.bytes,
            contentType: "application/pdf",
          },
        ],
        relatedType: "WorkOrder",
        relatedId: workOrder.id,
      },
    });
    expect(sent.status).toBe("SENT");
    expect((await sheet(asOf)).payable.toFixed(2)).toBe("0.00");

    await approveWorkOrder({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
      role: "OWNER",
    });
    const approved = await prisma.workOrder.findUniqueOrThrow({
      where: { id: workOrder.id },
    });
    // §15.6: numbering starts at WO1001, allocated on approval.
    expect(approved.workOrderNumber).toBe("WO1001");
    // The deduction reduced the payable without unbalancing anything.
    expect(approved.total.toFixed(2)).toBe("17000.00");

    let view = await sheet(asOf);
    expect(view.payable.toFixed(2)).toBe("17000.00");
    expect(view.balanced).toBe(true);

    await recordBillPayment({
      companyId: fixture.company.id,
      vendorId: consultant.id,
      date: new Date(Date.UTC(2026, 5, 25)),
      amount: "17000.00",
      currency: "PHP",
      paymentAccountId: fixture.code("1000").id,
      applications: [{ workOrderId: workOrder.id, amountApplied: "17000.00" }],
      role: "OWNER",
    });

    view = await sheet(asOf);
    expect(view.payable.toFixed(2)).toBe("0.00");
    expect(view.balanced).toBe(true);
    expect(
      (
        await prisma.workOrder.findUniqueOrThrow({
          where: { id: workOrder.id },
        })
      ).status,
    ).toBe("PAID");
  });

  // it.fails, so this line stays green while the gap is open and turns red the
  // moment it is closed — at which point delete the .fails, not the test.
  it.fails(
    "§15.11 NOT MET — a consultant payment drills to its entry but not to a document",
    async () => {
      const asOf = new Date(Date.UTC(2026, 5, 30));

      // One of each posting the app can make, so the drill-down is checked
      // against the source types that actually occur rather than the enum.
      const customer = await makeCustomer(fixture.company.id);
      const invoice = await makeDraftInvoice({
        companyId: fixture.company.id,
        customerId: customer.id,
        currency: "PHP",
        issueDate: new Date(Date.UTC(2026, 5, 1)),
        lines: [
          {
            description: "Consulting",
            quantity: "1",
            rate: "10000.00",
            incomeAccountId: fixture.code("4000").id,
          },
        ],
      });
      await issueInvoice({
        companyId: fixture.company.id,
        invoiceId: invoice.id,
        role: "OWNER",
      });
      await recordPayment({
        companyId: fixture.company.id,
        customerId: customer.id,
        date: new Date(Date.UTC(2026, 5, 10)),
        amount: "10000.00",
        currency: "PHP",
        depositAccountId: fixture.code("1000").id,
        applications: [{ invoiceId: invoice.id, amountApplied: "10000.00" }],
        role: "OWNER",
      });

      const consultant = await makeVendor(fixture.company.id, "CONSULTANT");
      const workOrder = await prisma.workOrder.create({
        data: {
          companyId: fixture.company.id,
          vendorId: consultant.id,
          issueDate: new Date(Date.UTC(2026, 5, 2)),
          dueDate: new Date(Date.UTC(2026, 5, 30)),
          currency: "PHP",
          lines: {
            create: [
              {
                lineNumber: 1,
                description: "Fieldwork",
                quantity: "1",
                rate: "5000.00",
                amount: "5000.00",
                accountId: fixture.code("6000").id,
              },
            ],
          },
        },
      });
      await approveWorkOrder({
        companyId: fixture.company.id,
        workOrderId: workOrder.id,
        role: "OWNER",
      });
      await recordBillPayment({
        companyId: fixture.company.id,
        vendorId: consultant.id,
        date: new Date(Date.UTC(2026, 5, 26)),
        amount: "5000.00",
        currency: "PHP",
        paymentAccountId: fixture.code("1000").id,
        applications: [{ workOrderId: workOrder.id, amountApplied: "5000.00" }],
        role: "OWNER",
      });

      // Walk the cash account — every flow above touches it.
      const detail = await accountDetail({
        companyId: fixture.company.id,
        accountId: fixture.code("1000").id,
        to: asOf,
      });
      expect(detail.rows.length).toBeGreaterThan(0);

      // KNOWN GAP (SPEC §15.11): a consultant payment drills to its journal entry
      // but not on to a document, because `sourceDocumentHref` has no case for
      // CONSULTANT_PAYMENT — and there is no screen for a bill payment to link
      // to. Marked failing on purpose rather than asserted away.
      const unlinked = [
        ...new Set(
          detail.rows
            .filter(
              (row) =>
                sourceDocumentHref(row.sourceType, row.sourceId) === null,
            )
            .map((row) => row.sourceType),
        ),
      ];
      // Every line already drills to its journal entry; this is the second hop,
      // from the entry to the document that caused it.
      expect(unlinked).toEqual([]);
    },
  );
});
