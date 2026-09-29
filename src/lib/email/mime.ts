import { randomBytes } from "node:crypto";

/**
 * Build the RFC 5322 message Gmail's API expects (SPEC §10). Written by hand
 * rather than pulling in a mailer: the API takes a base64url-encoded message,
 * and a dependency that mostly exists to open SMTP connections earns nothing
 * here.
 */

export type Attachment = { filename: string; content: Buffer; contentType?: string };

export type MessageInput = {
  from: string;
  /** Display name for the sender, e.g. "POISE FITNESS STUDIO". Optional. */
  fromName?: string | null;
  /** Where replies should go, when that is not the sending mailbox. */
  replyTo?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  /** Plain text. These emails are deliberately plain (SPEC §7.3, §10). */
  text: string;
  attachments?: Attachment[];
};

/** RFC 2047 for non-ASCII headers, so a name with an accent is not mangled. */
function encodeHeader(value: string): string {
  return /^[\x00-\x7F]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function foldBase64(input: string): string {
  return (input.match(/.{1,76}/g) ?? []).join("\r\n");
}

/**
 * `Name <address>`, with the name quoted so a comma or a full stop in it
 * cannot be read as the end of one address and the start of another.
 */
function address(email: string, name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed) return email;
  // A quote or backslash inside a quoted string has to be escaped, or the
  // header is malformed and the whole message is rejected.
  const quoted = trimmed.replace(/([\\"])/g, "\\$1");
  return `${encodeHeader(`"${quoted}"`)} <${email}>`;
}

export function buildMimeMessage(input: MessageInput): string {
  const headers: string[] = [
    `From: ${address(input.from, input.fromName)}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    // Only when it differs from the sender. A Reply-To repeating the From
    // address is noise some clients show to the reader as a second line.
    ...(input.replyTo && input.replyTo !== input.from
      ? [`Reply-To: ${input.replyTo}`]
      : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
  ];

  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    return [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      foldBase64(Buffer.from(input.text, "utf8").toString("base64")),
    ].join("\r\n");
  }

  const boundary = `ledger_${randomBytes(12).toString("hex")}`;
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    foldBase64(Buffer.from(input.text, "utf8").toString("base64")),
  ];

  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.contentType ?? "application/pdf"}; name="${attachment.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      "",
      foldBase64(attachment.content.toString("base64")),
    );
  }

  parts.push(`--${boundary}--`, "");
  return parts.join("\r\n");
}

/** Gmail wants the raw message base64url-encoded. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}
