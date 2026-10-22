import Link from "next/link";
import { redirect } from "next/navigation";
import { pageTitle } from "@/lib/brand";
import { prisma } from "@/lib/db";
import { sectionScope } from "@/lib/session-scope";
import { writeAudit } from "@/lib/audit";
import { failTo } from "@/lib/fail";
import { requestOrigin } from "@/lib/request-origin";
import { headers } from "next/headers";
import {
  authorizationUrl,
  connectedMailbox,
  gmailConfigured,
  hasInboxScopes,
} from "@/lib/email/gmail";
import { pollCompanyInbox } from "@/lib/receipts/inbox";
import { Alert, Button, Card, Field, Input, PageHeader } from "@/components/ui";

export const metadata = { title: pageTitle("Bills by email") };

/** A plausible address, checked loosely — the mailbox is the real judge. */
function looksLikeAnAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

/**
 * Setting up bills by email (SPEC §8.2 extension).
 *
 * Two things have to be true before anything arrives: this book has an
 * address of its own, and the connected Google account has said GAMIBOOK may
 * read that mailbox and file to Drive. The screen says which of the two is
 * missing rather than offering a switch that quietly does nothing.
 */
export default async function InboxSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; connected?: string; polled?: string }>;
}) {
  const scope = await sectionScope("VENDORS");
  scope.requireRole("OWNER");
  const params = await searchParams;

  const [company, connection] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: scope.companyId } }),
    connectedMailbox(scope.companyId),
  ]);

  const google = connection?.provider === "GOOGLE";
  const granted = google && hasInboxScopes(connection?.scope);
  const ready = granted && Boolean(company.inboxAddress);

  async function saveAddress(formData: FormData) {
    "use server";
    const inner = await sectionScope("VENDORS");
    inner.requireRole("OWNER");
    const raw = String(formData.get("inboxAddress") || "").trim().toLowerCase();

    if (raw && !looksLikeAnAddress(raw)) {
      failTo("/receipts/settings", "That does not look like an email address");
    }
    // Two books sharing an address would each claim the same message, and
    // whichever polled first would win. Refused rather than resolved.
    if (raw) {
      const clash = await prisma.company.findFirst({
        where: { inboxAddress: raw, id: { not: inner.companyId } },
        select: { name: true },
      });
      if (clash) {
        failTo(
          "/receipts/settings",
          `${clash.name} already takes bills at that address. Give this book one of its own.`,
        );
      }
    }

    await prisma.company.update({
      where: { id: inner.companyId },
      data: { inboxAddress: raw || null },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "inbox.address_set",
      entityType: "Company",
      entityId: inner.companyId,
      summary: raw || "turned off",
    });
    redirect("/receipts/settings?saved=1");
  }

  async function connect() {
    "use server";
    const inner = await sectionScope("VENDORS");
    inner.requireRole("OWNER");
    const origin = requestOrigin(await headers());
    redirect(authorizationUrl({ origin, state: `${inner.companyId}:inbox`, inbox: true }));
  }

  async function pollNow() {
    "use server";
    const inner = await sectionScope("VENDORS");
    inner.requireRole("OWNER");
    const here = await prisma.company.findFirstOrThrow({ where: { id: inner.companyId } });
    if (!here.inboxAddress) failTo("/receipts/settings", "Set the address first");

    let filed = 0;
    try {
      const result = await pollCompanyInbox({
        companyId: inner.companyId,
        companyName: here.name,
        address: here.inboxAddress,
      });
      filed = result.filed;
    } catch (thrown) {
      failTo(
        "/receipts/settings",
        thrown instanceof Error ? thrown.message : "Could not read the mailbox",
      );
    }
    redirect(`/receipts/settings?polled=${filed}`);
  }

  return (
    <>
      <PageHeader
        title="Bills by email"
        description="Forward a bill to this book's own address and it turns up in the receipt inbox, with the attachment filed in Drive."
      />

      <div className="mb-4">
        <Link href="/receipts">
          <Button variant="ghost">Back to the receipt inbox</Button>
        </Link>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? <Alert tone="success">Saved.</Alert> : null}
      {params.connected ? <Alert tone="success">Google connected.</Alert> : null}
      {params.polled ? (
        <Alert tone="success">
          {params.polled === "0"
            ? "Nothing new was waiting."
            : `${params.polled} message${params.polled === "1" ? "" : "s"} filed.`}
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-sm font-semibold">1 · Let GAMIBOOK read the mailbox</h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            Forwarded bills are collected from the Google account this book
            sends from. GAMIBOOK asks for two things: permission to read and
            label that mailbox, and permission to put files in Drive —{" "}
            <span className="font-medium">only the files it creates itself</span>, which is
            the narrowest Drive permission Google offers. It cannot see the
            rest of your Drive and it cannot delete mail.
          </p>

          {!gmailConfigured() ? (
            <Alert tone="warning">
              Google is not set up for this deployment. AUTH_GOOGLE_ID and
              AUTH_GOOGLE_SECRET have to be set before a mailbox can be
              connected at all.
            </Alert>
          ) : !google ? (
            <Alert tone="warning">
              No Google account is connected for this book yet. Connect one
              under{" "}
              <Link className="underline" href="/settings/email">
                Settings → Email
              </Link>
              , then come back.
            </Alert>
          ) : granted ? (
            <Alert tone="success">
              Connected as {connection?.emailAddress}, with permission to read
              the mailbox and file to Drive.
            </Alert>
          ) : (
            <>
              <Alert tone="info">
                Connected as {connection?.emailAddress}, but only to send. Reading
                needs a second trip through Google&apos;s consent screen.
              </Alert>
              <form action={connect} className="mt-3">
                <Button type="submit">Grant reading and Drive</Button>
              </form>
            </>
          )}
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold">2 · Give this book an address</h2>
          <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
            One login keeps several books, so each needs its own address to be
            told apart. The easy way is a plus-address on the mailbox you
            already have: anything sent to{" "}
            <code className="rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">
              docs+something@
            </code>{" "}
            is delivered to{" "}
            <code className="rounded bg-slate-100 px-1 text-xs dark:bg-slate-800">docs@</code>{" "}
            with nothing to set up.
          </p>

          <form action={saveAddress} className="space-y-3">
            <Field
              label="Forward bills for this book to"
              hint="Leave empty to stop collecting mail for this book."
            >
              <Input
                name="inboxAddress"
                type="email"
                inputMode="email"
                placeholder="docs+kasagami@bookkeepingpoint.com"
                defaultValue={company.inboxAddress ?? ""}
              />
            </Field>
            <Button type="submit">Save</Button>
          </form>

          {ready ? (
            <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
              <p className="mb-2 text-sm text-slate-600 dark:text-slate-400">
                The mailbox is read once an hour. To prove it works now:
              </p>
              <form action={pollNow}>
                <Button variant="secondary" type="submit">
                  Check for mail now
                </Button>
              </form>
            </div>
          ) : null}
        </Card>
      </div>

      <Card className="mt-4" tone="muted">
        <h2 className="mb-2 text-sm font-semibold">What happens to a forwarded bill</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-400">
          <li>
            Every PDF and photograph attached to it is copied into a GAMIBOOK
            folder in your Drive. Nothing is kept on this server.
          </li>
          <li>
            The message is listed in the receipt inbox with its date, its
            subject and a link to each file.
          </li>
          <li>
            It is labelled{" "}
            <code className="rounded bg-slate-200 px-1 text-xs dark:bg-slate-800">
              GAMIBOOK/Filed
            </code>{" "}
            in the mailbox, so you can see at a glance what has been taken.
          </li>
          <li>
            <span className="font-medium">Nothing is posted.</span> A forwarded bill sits in the
            inbox until you record it as a bill or a direct expense.
          </li>
        </ul>
      </Card>
    </>
  );
}
