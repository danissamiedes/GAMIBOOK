import { googleAccessToken } from "@/lib/email/gmail";

/**
 * Reading the connected mailbox, for the receipt inbox (SPEC §8.2
 * extension).
 *
 * Kept apart from `email/gmail.ts`, which sends: that file is about getting
 * mail out of the company's mailbox and this one is about taking bills out
 * of it, and the two have different scopes, different failure modes and
 * nothing in common but the token.
 */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The label put on a message once it has been filed, for the human. */
export const FILED_LABEL = "GAMIBOOK/Filed";

export class GmailReadError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "GmailReadError";
  }
}

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new GmailReadError(
      `Gmail refused the request (${response.status}): ${detail}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return (await response.json()) as T;
}

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};

type GmailMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
};

/** Every part in the tree, flattened, so an attachment nested three deep is found. */
function flatten(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(flatten)];
}

function header(message: GmailMessage, name: string): string {
  const found = (message.payload?.headers ?? []).find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? "";
}

export type InboundAttachment = {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type InboundMessage = {
  id: string;
  subject: string;
  from: string;
  deliveredTo: string | null;
  snippet: string;
  receivedAt: Date;
  attachments: InboundAttachment[];
};

/**
 * What counts as a bill worth keeping.
 *
 * Images and PDFs only. A forwarded email carries a signature logo, a
 * tracking pixel and sometimes a vCard, and filing those to Drive would turn
 * the folder into noise within a week. Inline images are excluded for the
 * same reason: an attachment a person attached has a filename, and the ones
 * that do not are furniture.
 */
function isBillLike(part: GmailPart): boolean {
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";
  if (!filename || !part.body?.attachmentId) return false;
  if (mime === "application/pdf") return true;
  if (mime.startsWith("image/")) {
    // A logo in a signature is an image with a filename too, so the obvious
    // ones are dropped by size: nothing legible is under 10 kB.
    return (part.body.size ?? 0) >= 10_000;
  }
  return false;
}

/**
 * Messages delivered to one address that have not been filed yet.
 *
 * `to:` rather than `deliveredto:` because Gmail matches the plus-address
 * form on `to:` and forwarded mail does not always carry a Delivered-To
 * header. The label keeps a second pass from re-reading what the first one
 * took; the database's unique index is what actually guarantees it.
 */
export async function listUnfiled(options: {
  companyId: string;
  address: string;
  /** How far back to look. A mailbox is not a backlog to import wholesale. */
  days?: number;
  max?: number;
}): Promise<string[]> {
  const token = await googleAccessToken(options.companyId);
  const query = [
    `to:${options.address}`,
    `-label:${FILED_LABEL.replace(/\//g, "-")}`,
    `newer_than:${options.days ?? 30}d`,
    "has:attachment",
  ].join(" ");

  const found = await call<{ messages?: { id: string }[] }>(
    token,
    `/messages?q=${encodeURIComponent(query)}&maxResults=${options.max ?? 25}`,
  );
  return (found.messages ?? []).map((message) => message.id);
}

/** One message, with its headers and the attachments worth keeping. */
export async function readMessage(
  companyId: string,
  messageId: string,
): Promise<InboundMessage> {
  const token = await googleAccessToken(companyId);
  const message = await call<GmailMessage>(token, `/messages/${messageId}?format=full`);

  const attachments = flatten(message.payload)
    .filter(isBillLike)
    .map((part) => ({
      attachmentId: part.body!.attachmentId!,
      filename: part.filename!,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    }));

  return {
    id: message.id,
    subject: header(message, "Subject") || "(no subject)",
    from: header(message, "From"),
    deliveredTo: header(message, "Delivered-To") || header(message, "To") || null,
    snippet: message.snippet ?? "",
    receivedAt: message.internalDate
      ? new Date(Number(message.internalDate))
      : new Date(),
    attachments,
  };
}

/** The bytes of one attachment. Base64url, as Gmail hands them over. */
export async function readAttachment(
  companyId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const token = await googleAccessToken(companyId);
  const part = await call<{ data?: string }>(
    token,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  return Buffer.from((part.data ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** The id of the filed label, created on first use. */
async function filedLabelId(companyId: string): Promise<string> {
  const token = await googleAccessToken(companyId);
  const { labels } = await call<{ labels?: { id: string; name: string }[] }>(token, "/labels");
  const existing = (labels ?? []).find((label) => label.name === FILED_LABEL);
  if (existing) return existing.id;

  const created = await call<{ id: string }>(token, "/labels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: FILED_LABEL,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  });
  return created.id;
}

/**
 * Mark a message as taken.
 *
 * Best-effort on purpose: the row is already in the database by the time
 * this runs, and the unique index is what stops a second copy. A label that
 * could not be applied is worth a line in the log and nothing more —
 * failing the whole poll over it would lose the bills that did arrive.
 */
export async function markFiled(companyId: string, messageId: string): Promise<boolean> {
  try {
    const token = await googleAccessToken(companyId);
    const labelId = await filedLabelId(companyId);
    await call(token, `/messages/${messageId}/modify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
    return true;
  } catch (error) {
    console.error("[inbox] could not label message", messageId, error);
    return false;
  }
}
