/**
 * Email configuration check: `npm run email:check [address]`
 *
 * Tells you exactly which part of the Gmail setup is missing, and with an
 * address, sends one real test message through the same path the app uses.
 */
import { PrismaClient } from "@prisma/client";
import { encryptionAvailable } from "../src/lib/email/crypto";
import { dryRun, gmailConfigured } from "../src/lib/email/gmail";
import { sendEmail } from "../src/lib/email/send";

const prisma = new PrismaClient();

const tick = (ok: boolean) => (ok ? "  ok  " : " MISS ");

async function main() {
  const to = process.argv[2];

  console.log("\nGmail configuration\n");

  const hasClient = gmailConfigured();
  console.log(`[${tick(hasClient)}] AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET`);
  if (!hasClient) {
    console.log("        Create an OAuth client in Google Cloud — see docs/gmail-setup.md");
  }

  const hasKey = encryptionAvailable();
  console.log(`[${tick(hasKey)}] TOKEN_ENCRYPTION_KEY (32 bytes, base64)`);
  if (!hasKey) console.log("        Generate one with: openssl rand -base64 32");

  const isDryRun = dryRun();
  console.log(`[${tick(!isDryRun)}] EMAIL_DRY_RUN is off`);
  if (isDryRun) {
    console.log("        Dry run is ON: mail is composed and logged, never sent.");
    console.log("        Set EMAIL_DRY_RUN=false when you want it to go out for real.");
  }

  const companies = await prisma.company.findMany({
    select: { id: true, name: true, emailConnection: { select: { emailAddress: true, needsReconnectAt: true, lastError: true } } },
    orderBy: { name: "asc" },
  });

  console.log("\nConnected mailboxes\n");
  for (const company of companies) {
    const connection = company.emailConnection;
    if (!connection) {
      console.log(`[${tick(false)}] ${company.name}: no mailbox connected`);
      console.log("        Connect it under Settings → Email while signed in to that company.");
    } else if (connection.needsReconnectAt) {
      console.log(`[${tick(false)}] ${company.name}: ${connection.emailAddress} needs reconnecting`);
      if (connection.lastError) console.log(`        ${connection.lastError}`);
    } else {
      console.log(`[${tick(true)}] ${company.name}: sending as ${connection.emailAddress}`);
    }
  }

  if (!to) {
    console.log("\nPass an address to send a test: npm run email:check you@example.com\n");
    return;
  }

  const company = companies.find((candidate) => candidate.emailConnection) ?? companies[0];
  if (!company) {
    console.log("\nNo companies exist yet — run `npm run seed` first.\n");
    return;
  }

  console.log(`\nSending a test from ${company.name} to ${to} …`);
  const result = await sendEmail({
    companyId: company.id,
    email: {
      to: [to],
      cc: [],
      subject: "Ledger test message",
      body: [
        "This is a test from Ledger.",
        "",
        "If you are reading it in your inbox, the Gmail connection works and",
        "work orders and invoices will send the same way.",
      ].join("\n"),
      attachments: [],
      relatedType: "TestEmail",
    },
  });

  if (result.status === "SENT" && result.dryRun) {
    console.log("\nLogged, not sent — EMAIL_DRY_RUN is still true.\n");
  } else if (result.status === "SENT") {
    console.log(`\nSent. Gmail message id ${result.gmailMessageId}. Check the Sent folder too.\n`);
  } else {
    console.log(`\nFailed: ${result.error}\n`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
