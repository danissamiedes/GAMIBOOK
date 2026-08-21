import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { EmailTemplateKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import {
  authorizationUrl,
  disconnectMailbox,
  dryRun,
  gmailConfigured,
  connectedMailbox,
} from "@/lib/email/gmail";
import { encryptionAvailable } from "@/lib/email/crypto";
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_LABELS,
  TEMPLATE_PLACEHOLDERS,
  installDefaultTemplates,
  renderTemplate,
  templateFor,
} from "@/lib/email/templates";
import { sendEmail } from "@/lib/email/send";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: "Email settings — Ledger" };

const KINDS: EmailTemplateKind[] = ["INVOICE", "INVOICE_REMINDER", "WORK_ORDER", "PAYMENT_RECEIPT"];

const PREVIEW_VALUES: Record<string, string> = {
  customer_name: "Cebu Retail Group",
  consultant_name: "Abigail Bautista",
  invoice_number: "INV1042",
  work_order_number: "WO1007",
  total: "PHP 50,000.00",
  amount: "PHP 50,000.00",
  due_date: "15 September 2026",
  payment_date: "1 September 2026",
  days_overdue: "12",
  work_order_count: "3",
  work_order_list: "WO1007, WO1008, WO1009",
};

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; connected?: string; sent?: string }>;
}) {
  const scope = await sectionScope("SETTINGS");
  const params = await searchParams;

  const [company, connection, templates] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    connectedMailbox(scope.companyId),
    Promise.all(KINDS.map(async (kind) => ({ kind, template: await templateFor(scope.companyId, kind) }))),
  ]);

  const host = (await headers()).get("host") ?? "localhost:3000";
  const origin = `${process.env.NODE_ENV === "production" ? "https" : "http"}://${host}`;

  async function connect() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const innerHost = (await headers()).get("host") ?? "localhost:3000";
    const innerOrigin = `${process.env.NODE_ENV === "production" ? "https" : "http"}://${innerHost}`;
    if (!gmailConfigured()) redirect("/settings/email?error=Google%20OAuth%20is%20not%20configured");
    if (!encryptionAvailable()) {
      redirect("/settings/email?error=TOKEN_ENCRYPTION_KEY%20is%20not%20set");
    }
    redirect(authorizationUrl({ origin: innerOrigin, state: inner.companyId }));
  }

  async function disconnect() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    await disconnectMailbox(inner.companyId);
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "email.disconnected",
      entityType: "EmailConnection",
    });
    redirect("/settings/email?saved=1");
  }

  async function saveTemplate(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const kind = String(formData.get("kind")) as EmailTemplateKind;
    if (!KINDS.includes(kind)) redirect("/settings/email");

    await prisma.emailTemplate.upsert({
      where: { companyId_kind: { companyId: inner.companyId, kind } },
      create: {
        companyId: inner.companyId,
        kind,
        subject: String(formData.get("subject") || DEFAULT_TEMPLATES[kind].subject),
        body: String(formData.get("body") || DEFAULT_TEMPLATES[kind].body),
      },
      update: {
        subject: String(formData.get("subject") || ""),
        body: String(formData.get("body") || ""),
      },
    });
    redirect("/settings/email?saved=1");
  }

  async function resetTemplates() {
    "use server";
    const inner = await sectionScope("SETTINGS");
    await prisma.emailTemplate.deleteMany({ where: { companyId: inner.companyId } });
    await installDefaultTemplates(inner.companyId);
    redirect("/settings/email?saved=1");
  }

  async function sendTest(formData: FormData) {
    "use server";
    const inner = await sectionScope("SETTINGS");
    const kind = String(formData.get("kind")) as EmailTemplateKind;
    const to = String(formData.get("to") || "").trim();
    if (!to) redirect("/settings/email?error=Enter%20an%20address%20to%20test%20with");

    const template = await templateFor(inner.companyId, kind);
    const innerCompany = await prisma.company.findFirstOrThrow({ where: { id: inner.companyId } });
    const values = { ...PREVIEW_VALUES, company_name: innerCompany.name };

    const result = await sendEmail({
      companyId: inner.companyId,
      userId: inner.userId,
      email: {
        to: [to],
        cc: [],
        subject: `[Test] ${renderTemplate(template.subject, values)}`,
        body: renderTemplate(template.body, values),
        attachments: [],
        relatedType: "TestEmail",
      },
    });
    redirect(`/settings/email?sent=${result.status.toLowerCase()}`);
  }

  return (
    <>
      <PageHeader
        title="Email"
        description="Mail is sent from your own Google mailbox, so it appears in Sent and replies come back to you."
      />

      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.connected ? <Alert tone="success">Google account connected.</Alert> : null}
      {params.error ? <Alert tone="error">{decodeURIComponent(params.error)}</Alert> : null}
      {params.sent === "sent" ? (
        <Alert tone="success">
          Test {dryRun() ? "logged (dry run — nothing actually sent)" : "sent"}.
        </Alert>
      ) : null}
      {params.sent === "failed" ? (
        <Alert tone="error">The test failed. The email log has the reason.</Alert>
      ) : null}

      {dryRun() ? (
        <Alert tone="warning">
          <strong>EMAIL_DRY_RUN is on.</strong> Every send is written to the log and nothing leaves
          this machine. Turn it off in the environment when you are ready to send real mail.
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Google account</h2>

          {!gmailConfigured() ? (
            <Alert tone="warning">
              Set <code>AUTH_GOOGLE_ID</code> and <code>AUTH_GOOGLE_SECRET</code>, and add{" "}
              <code>{origin}/api/email/google/callback</code> as an authorised redirect URI in the
              Google Cloud console. Only the <code>gmail.send</code> scope is requested — this app
              cannot read your mail.
            </Alert>
          ) : connection ? (
            <div className="space-y-3">
              <p className="text-sm">
                Connected as <strong>{connection.emailAddress}</strong>
              </p>
              {connection.needsReconnectAt ? (
                <Alert tone="error">
                  Google has stopped accepting this connection — reconnect to keep sending.
                  {connection.lastError ? (
                    <span className="mt-1 block text-xs">{connection.lastError}</span>
                  ) : null}
                </Alert>
              ) : null}
              <form action={disconnect}>
                <Button variant="secondary" type="submit">
                  Disconnect
                </Button>
              </form>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-400">
                No mailbox connected. Until one is, invitations and documents fall back to a
                copyable link.
              </p>
              <form action={connect}>
                <Button type="submit">Connect Google account</Button>
              </form>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Send a test</h2>
          <form action={sendTest} className="space-y-3">
            <Field label="Template">
              <select
                name="kind"
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                defaultValue="INVOICE"
              >
                {KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {TEMPLATE_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Send to">
              <Input name="to" type="email" placeholder="you@example.com" />
            </Field>
            <Button type="submit">Send test</Button>
          </form>
          <form action={resetTemplates} className="mt-4">
            <Button variant="ghost" type="submit">
              Reset all templates to defaults
            </Button>
          </form>
        </Card>
      </div>

      <h2 className="mt-8 mb-3 text-sm font-semibold">Templates</h2>
      <div className="space-y-4">
        {templates.map(({ kind, template }) => {
          const values = { ...PREVIEW_VALUES, company_name: company.name };
          return (
            <Card key={kind}>
              <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
                <form action={saveTemplate} className="space-y-3">
                  <input type="hidden" name="kind" value={kind} />
                  <h3 className="text-sm font-semibold">{TEMPLATE_LABELS[kind]}</h3>
                  <Field label="Subject">
                    <Input name="subject" defaultValue={template.subject} />
                  </Field>
                  <Field
                    label="Body"
                    hint={`Placeholders: ${TEMPLATE_PLACEHOLDERS[kind]
                      .map((placeholder) => `{{${placeholder}}}`)
                      .join(", ")}`}
                  >
                    <textarea
                      name="body"
                      rows={8}
                      defaultValue={template.body}
                      className="w-full rounded-md border border-slate-300 bg-white p-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                  </Field>
                  <Button variant="secondary" type="submit">
                    Save template
                  </Button>
                </form>

                <div className="rounded-md bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
                  <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Preview</p>
                  <p className="font-medium">{renderTemplate(template.subject, values)}</p>
                  <p className="mt-2 whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                    {renderTemplate(template.body, values)}
                  </p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
