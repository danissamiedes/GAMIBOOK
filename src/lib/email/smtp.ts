import nodemailer from "nodemailer";
import type { EmailConnection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { EmailNotConnectedError, EmailSendError } from "./gmail";

/**
 * Sending through a plain SMTP mailbox (SPEC §10).
 *
 * Google was the only option while the practice ran on its own Gmail. A client
 * whose mail is Titan, Outlook or Zoho cannot use that path at all: the Gmail
 * API will not put an address on the envelope that the authenticated account
 * does not own. For those companies this is not a convenience, it is the
 * difference between their work orders coming from them and coming from
 * somebody else.
 *
 * A mailer dependency earns its place here in a way it did not for the Gmail
 * API. That took a base64 string over HTTPS; this needs AUTH, STARTTLS
 * negotiation, line folding and dot-stuffing, and hand-rolling those is how a
 * message silently arrives corrupted at one provider in ten.
 */

export type SmtpSettings = {
  host: string;
  port: number;
  /** Implicit TLS (465) versus STARTTLS (587). */
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
};

/** Ports that mean "plain text, forever". Refused rather than warned about. */
const INSECURE_PORTS = [25, 2525];

export type SmtpProblem = { field: keyof SmtpSettings | "form"; message: string };

export function validateSmtp(input: Partial<SmtpSettings>): SmtpProblem | null {
  if (!input.host?.trim()) return { field: "host", message: "The SMTP server address is needed." };
  if (!input.port || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    return { field: "port", message: "The port is a number between 1 and 65535." };
  }
  if (INSECURE_PORTS.includes(input.port)) {
    return {
      field: "port",
      message:
        "Port 25 sends the password in the clear. Use 465, or 587 with STARTTLS — your provider supports one of them.",
    };
  }
  if (!input.username?.trim()) return { field: "username", message: "The username is needed." };
  if (!input.password) return { field: "password", message: "The mailbox password is needed." };
  if (!input.fromAddress?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.fromAddress)) {
    return { field: "fromAddress", message: "That does not look like an email address." };
  }
  return null;
}

function transportFor(settings: Omit<SmtpSettings, "fromAddress">) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.username, pass: settings.password },
    // A mail server that cannot prove who it is gets no password from us.
    // Self-signed certificates are common on self-hosted servers and are
    // exactly the case where a silent downgrade would matter most.
    tls: { rejectUnauthorized: true },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

/**
 * Prove the settings work before storing them.
 *
 * Called on save rather than left for the first real send. Credentials that
 * only fail when a batch of eighteen work orders goes out fail at the worst
 * possible moment, and the person who could fix them has moved on to something
 * else by then.
 */
export async function verifySmtp(settings: SmtpSettings): Promise<{ ok: true } | { ok: false; reason: string }> {
  const transport = transportFor(settings);
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  } finally {
    transport.close();
  }
}

/** Turn a provider's error into something the person reading it can act on. */
function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code;

  if (code === "EAUTH" || /invalid login|authentication fail|535/i.test(raw)) {
    return "The server refused that username and password. Titan and Outlook often need the full email address as the username.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "That server address could not be found. Check the hostname for a typo.";
  }
  if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET") {
    return "Could not reach the server on that port. Try 465 with TLS, or 587 with STARTTLS.";
  }
  if (/self.signed|certificate/i.test(raw)) {
    return "The server's TLS certificate could not be verified.";
  }
  return raw;
}

/** Store a connection, replacing whatever was there. The password is sealed. */
export async function connectSmtp(options: {
  companyId: string;
  userId?: string | null;
  settings: SmtpSettings;
}): Promise<void> {
  const sealed = encryptSecret(options.settings.password);
  const shared = {
    provider: "SMTP" as const,
    emailAddress: options.settings.fromAddress.trim().toLowerCase(),
    smtpHost: options.settings.host.trim(),
    smtpPort: options.settings.port,
    smtpSecure: options.settings.secure,
    smtpUsername: options.settings.username.trim(),
    smtpPasswordCiphertext: sealed.ciphertext,
    smtpPasswordKey: sealed.encryptedDataKey,
    // Switching provider must clear the other one's credentials rather than
    // leave a stale Google token sitting next to live SMTP settings.
    refreshTokenCiphertext: null,
    encryptedDataKey: null,
    scope: "",
    needsReconnectAt: null,
    lastError: null,
  };

  await prisma.emailConnection.upsert({
    where: { companyId: options.companyId },
    create: {
      companyId: options.companyId,
      connectedByUserId: options.userId ?? null,
      ...shared,
    },
    update: { connectedByUserId: options.userId ?? null, ...shared },
  });
}

function settingsFrom(connection: EmailConnection): SmtpSettings {
  if (
    !connection.smtpHost ||
    !connection.smtpPort ||
    !connection.smtpUsername ||
    !connection.smtpPasswordCiphertext ||
    !connection.smtpPasswordKey
  ) {
    throw new EmailNotConnectedError("This company's SMTP settings are incomplete.");
  }
  return {
    host: connection.smtpHost,
    port: connection.smtpPort,
    secure: connection.smtpSecure ?? true,
    username: connection.smtpUsername,
    password: decryptSecret({
      ciphertext: connection.smtpPasswordCiphertext,
      encryptedDataKey: connection.smtpPasswordKey,
    }),
    fromAddress: connection.emailAddress,
  };
}

/**
 * Send one already-built RFC 5322 message.
 *
 * Takes the raw message rather than its parts so both providers send exactly
 * the same bytes — the headers, the encoding and the attachment boundaries are
 * decided once, in `buildMimeMessage`, and neither transport gets its own
 * opinion about them.
 */
export async function sendViaSmtp(options: {
  connection: EmailConnection;
  raw: string;
  to: string[];
  cc: string[];
}): Promise<{ messageId: string }> {
  const settings = settingsFrom(options.connection);
  const transport = transportFor(settings);

  try {
    const result = await transport.sendMail({
      envelope: { from: settings.fromAddress, to: [...options.to, ...options.cc] },
      raw: options.raw,
    });
    return { messageId: result.messageId ?? "smtp" };
  } catch (error) {
    const code = (error as { responseCode?: number } | null)?.responseCode;
    // 4xx is the server saying "not now"; 5xx is "not ever". Only the first is
    // worth the retry loop in send.ts.
    const transient = typeof code === "number" ? code >= 400 && code < 500 : !isPermanent(error);
    throw new EmailSendError(describe(error), transient);
  } finally {
    transport.close();
  }
}

function isPermanent(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "EAUTH" || code === "ENOTFOUND" || code === "EENVELOPE";
}
