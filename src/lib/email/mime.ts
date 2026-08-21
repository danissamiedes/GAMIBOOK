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

export function buildMimeMessage(input: MessageInput): string {
  const headers: string[] = [
    `From: ${input.from}`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
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
