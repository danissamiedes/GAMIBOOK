import type { EmailTemplateKind } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Per-company email templates (SPEC §10). Short and plain: these are read on a
 * phone by people who are not looking for prose.
 */

export const TEMPLATE_LABELS: Record<EmailTemplateKind, string> = {
  INVOICE: "Invoice",
  INVOICE_REMINDER: "Invoice reminder",
  WORK_ORDER: "Work order",
  PAYMENT_RECEIPT: "Payment receipt",
};

/** Placeholders each template may use, shown beside the editor. */
export const TEMPLATE_PLACEHOLDERS: Record<EmailTemplateKind, string[]> = {
  INVOICE: ["customer_name", "invoice_number", "total", "due_date", "company_name"],
  INVOICE_REMINDER: ["customer_name", "invoice_number", "total", "due_date", "days_overdue", "company_name"],
  WORK_ORDER: [
    "consultant_name",
    "work_order_number",
    "total",
    "due_date",
    "company_name",
    "work_order_count",
    "work_order_list",
  ],
  PAYMENT_RECEIPT: ["customer_name", "amount", "payment_date", "company_name"],
};

export const DEFAULT_TEMPLATES: Record<EmailTemplateKind, { subject: string; body: string }> = {
  INVOICE: {
    subject: "Invoice {{invoice_number}} from {{company_name}}",
    body: `Hi {{customer_name}},

Invoice {{invoice_number}} for {{total}} is attached, due {{due_date}}.

Thanks,
{{company_name}}`,
  },
  INVOICE_REMINDER: {
    subject: "Reminder: invoice {{invoice_number}} is due",
    body: `Hi {{customer_name}},

A reminder that invoice {{invoice_number}} for {{total}} was due on {{due_date}}. It is attached again for convenience.

If it is already paid, please ignore this.

Thanks,
{{company_name}}`,
  },
  WORK_ORDER: {
    subject: "Work order {{work_order_number}} from {{company_name}}",
    body: `Hi {{consultant_name}},

Your work order {{work_order_number}} for {{total}} is attached.

Please check the description, quantity and rate, and let us know if anything is wrong.

Thanks,
{{company_name}}`,
  },
  PAYMENT_RECEIPT: {
    subject: "Receipt for your payment to {{company_name}}",
    body: `Hi {{customer_name}},

Thank you — we have received {{amount}} on {{payment_date}}. The receipt is attached.

{{company_name}}`,
  },
};

/** Substitute `{{placeholder}}`; unknown ones are left visible, not blanked. */
export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? match : value;
  });
}

export async function templateFor(companyId: string, kind: EmailTemplateKind) {
  const stored = await prisma.emailTemplate.findUnique({
    where: { companyId_kind: { companyId, kind } },
  });
  return stored ?? { ...DEFAULT_TEMPLATES[kind], companyId, kind, id: "default" };
}

export async function installDefaultTemplates(companyId: string) {
  for (const kind of Object.keys(DEFAULT_TEMPLATES) as EmailTemplateKind[]) {
    await prisma.emailTemplate.upsert({
      where: { companyId_kind: { companyId, kind } },
      create: { companyId, kind, ...DEFAULT_TEMPLATES[kind] },
      update: {},
    });
  }
}
