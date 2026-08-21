import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { buildMimeMessage, toGmailRaw } from "@/lib/email/mime";
import { DEFAULT_TEMPLATES, renderTemplate, installDefaultTemplates, templateFor } from "@/lib/email/templates";
import {
  prepareInvoiceEmail,
  prepareWorkOrderEmail,
  sendEmail,
  stampEmailed,
  workOrderRecipients,
} from "@/lib/email/send";
import { issueInvoice } from "@/lib/invoices/service";
import { approveWorkOrder } from "@/lib/payables/work-orders";
import { resetStorage } from "@/lib/storage";
import {
  makeCompanyWithChart,
  makeDraftInvoice,
  makeVendor,
  prisma,
  resetDatabase,
} from "./helpers";

describe("MIME building (SPEC §10)", () => {
  it("builds a plain message", () => {
    const mime = buildMimeMessage({
      from: "books@example.test",
      to: ["client@example.test"],
      subject: "Invoice INV1001",
      text: "Hi there",
    });
    expect(mime).toContain("From: books@example.test");
    expect(mime).toContain("To: client@example.test");
    expect(mime).toContain("Subject: Invoice INV1001");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain(Buffer.from("Hi there").toString("base64"));
  });

  it("attaches a PDF as multipart/mixed", () => {
    const mime = buildMimeMessage({
      from: "books@example.test",
      to: ["client@example.test"],
      cc: ["manager@example.test"],
      subject: "Work order",
      text: "Attached.",
      attachments: [
        { filename: "WorkOrder-WO1001-abigail.pdf", content: Buffer.from("%PDF-1.7 fake") },
      ],
    });

    expect(mime).toContain("Cc: manager@example.test");
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="ledger_[0-9a-f]+"/);
    expect(mime).toContain('filename="WorkOrder-WO1001-abigail.pdf"');
    expect(mime).toContain("Content-Disposition: attachment");
    expect(mime.trimEnd().endsWith("--")).toBe(true);
  });

  it("encodes a non-ASCII subject rather than mangling it", () => {
    const mime = buildMimeMessage({
      from: "a@b.test",
      to: ["c@d.test"],
      subject: "Facturación — José",
      text: "hi",
    });
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("Subject: Facturación");
  });

  it("encodes for Gmail as base64url", () => {
    const raw = toGmailRaw("From: a@b.test\r\n\r\nbody");
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, "base64url").toString()).toContain("From: a@b.test");
  });
});

describe("templates", () => {
  it("substitutes placeholders and leaves unknown ones visible", () => {
    const rendered = renderTemplate("Hi {{customer_name}}, {{total}} due {{due_date}}. {{mystery}}", {
      customer_name: "Acme",
      total: "PHP 1,000.00",
      due_date: "2026-09-01",
    });
    expect(rendered).toBe("Hi Acme, PHP 1,000.00 due 2026-09-01. {{mystery}}");
  });

  it("ships a default for every kind", () => {
    for (const [kind, template] of Object.entries(DEFAULT_TEMPLATES)) {
      expect(template.subject.length, kind).toBeGreaterThan(5);
      expect(template.body.length, kind).toBeGreaterThan(20);
    }
  });
});

describe("sending", () => {
  let fixture: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = mkdtempSync(path.join(tmpdir(), "ledger-email-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.EMAIL_DRY_RUN = "true";
    resetStorage();
    fixture = await makeCompanyWithChart("Email Co", "PHP");
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await resetDatabase();
    await prisma.$disconnect();
  });

  const issuedInvoice = async (emails: string[] = ["ap@client.test"]) => {
    const customer = await prisma.customer.create({
      data: {
        companyId: fixture.company.id,
        name: "Cebu Retail",
        emails,
        defaultCurrency: "PHP",
      },
    });
    const invoice = await makeDraftInvoice({
      companyId: fixture.company.id,
      customerId: customer.id,
      currency: "PHP",
      lines: [
        { description: "Work", quantity: "1", rate: "12000.00", incomeAccountId: fixture.code("4000").id },
      ],
    });
    await issueInvoice({ companyId: fixture.company.id, invoiceId: invoice.id });
    return invoice;
  };

  it("dry-run writes the log and sends nothing", async () => {
    // The requirement from SPEC §10, and the Phase 7 test named in §14.
    const invoice = await issuedInvoice();
    const email = await prepareInvoiceEmail({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });
    const result = await sendEmail({ companyId: fixture.company.id, email });

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe("SENT");
    expect(result.gmailMessageId).toBe("dry-run");

    const log = await prisma.emailLog.findUniqueOrThrow({ where: { id: result.emailLogId } });
    expect(log.status).toBe("SENT");
    expect(log.toAddresses).toEqual(["ap@client.test"]);
    expect(log.attachmentNames[0]).toMatch(/^Invoice-INV1001-cebu-retail\.pdf$/);
    expect(log.bodySnapshot).toContain("Cebu Retail");
    // No mailbox is connected, and dry-run never needed one.
    expect(await prisma.emailConnection.count()).toBe(0);
  });

  it("fails cleanly with no recipient, and logs why", async () => {
    const invoice = await issuedInvoice([]);
    const email = await prepareInvoiceEmail({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });
    const result = await sendEmail({ companyId: fixture.company.id, email });

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/No recipient/);
  });

  it("fills the invoice template from the document", async () => {
    const invoice = await issuedInvoice();
    const email = await prepareInvoiceEmail({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });

    expect(email.subject).toContain("INV1001");
    expect(email.body).toContain("PHP 12,000.00");
    expect(email.body).not.toContain("{{");
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0].content.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("resolves work order recipients from the consultant's own setup", () => {
    expect(
      workOrderRecipients({ email: "a@b.test", ccEmails: ["m@b.test"], sendEmails: true }),
    ).toEqual({ to: ["a@b.test"], cc: ["m@b.test"] });

    expect(workOrderRecipients({ email: "a@b.test", ccEmails: [], sendEmails: false })).toEqual({
      to: [],
      cc: [],
      reason: "Marked not to be emailed",
    });

    expect(workOrderRecipients({ email: null, ccEmails: [], sendEmails: true })).toEqual({
      to: [],
      cc: [],
      reason: "No email address on file",
    });
  });

  it("prepares a work order email and says why a consultant is excluded", async () => {
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT", {
      name: "Chareze Valencia",
    });
    await prisma.vendor.update({
      where: { id: consultant.id },
      data: { email: null, sendEmails: false },
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
              description: "Consultation",
              quantity: "1",
              rate: "25000.00",
              amount: "25000.00",
              accountId: fixture.code("5000").id,
            },
          ],
        },
      },
    });
    await approveWorkOrder({ companyId: fixture.company.id, workOrderId: workOrder.id });

    const email = await prepareWorkOrderEmail({
      companyId: fixture.company.id,
      workOrderId: workOrder.id,
    });
    expect(email.to).toEqual([]);
    expect(email.excludedReason).toBe("Marked not to be emailed");
    // The PDF is still produced — the document exists whether or not it is sent.
    expect(email.attachments[0].filename).toBe("WorkOrder-WO1001-chareze-valencia.pdf");
  });

  it("stamps lastEmailedAt only when asked, after a send", async () => {
    const invoice = await issuedInvoice();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).lastEmailedAt).toBeNull();

    await stampEmailed("Invoice", invoice.id, fixture.company.id);
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).lastEmailedAt,
    ).not.toBeNull();
  });

  it("stores per-company templates and reads them back", async () => {
    await installDefaultTemplates(fixture.company.id);
    await prisma.emailTemplate.update({
      where: { companyId_kind: { companyId: fixture.company.id, kind: "WORK_ORDER" } },
      data: { subject: "Your work order {{work_order_number}}" },
    });

    const template = await templateFor(fixture.company.id, "WORK_ORDER");
    expect(template.subject).toBe("Your work order {{work_order_number}}");

    // A company with nothing stored still gets a usable template.
    const other = await makeCompanyWithChart("No Templates Co", "PHP");
    const fallback = await templateFor(other.company.id, "INVOICE");
    expect(fallback.subject).toBe(DEFAULT_TEMPLATES.INVOICE.subject);
  });

  it("keeps one company's email log out of another's", async () => {
    const invoice = await issuedInvoice();
    const email = await prepareInvoiceEmail({
      companyId: fixture.company.id,
      invoiceId: invoice.id,
    });
    await sendEmail({ companyId: fixture.company.id, email });

    const other = await makeCompanyWithChart("Neighbour", "PHP");
    expect(await prisma.emailLog.count({ where: { companyId: other.company.id } })).toBe(0);
  });
});
