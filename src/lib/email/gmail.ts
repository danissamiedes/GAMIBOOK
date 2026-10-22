import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Gmail sending (SPEC §10). Mail goes **from the user's own mailbox**, so it
 * lands in their Sent folder and replies come back to a person rather than to
 * a no-reply address.
 *
 * Only `gmail.send` is requested — the narrowest scope that works — unless
 * a company turns on the receipt inbox (SPEC §8.2 extension), which cannot
 * be done without reading the mailbox. That is asked for when the feature is
 * switched on and not before: a read scope granted speculatively, to make
 * some future feature easier, would still be a poor trade.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/**
 * Read and label, for the receipt inbox. `modify` rather than `readonly`
 * because the poll marks what it has filed, which is how the mailbox itself
 * tells you what GAMIBOOK has taken. It cannot delete anything: that needs
 * `gmail.modify`'s absent sibling, the full mail scope.
 */
export const GMAIL_INBOX_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/**
 * Drive, at its narrowest: an app with `drive.file` can only see and touch
 * the files it created itself. Forwarded attachments go into a folder this
 * app makes, and the rest of the Drive stays invisible to it.
 */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** The scopes a company needs granted before its inbox can be polled. */
export const INBOX_SCOPES = [GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE];

/** Whether a stored grant covers reading the mailbox and filing to Drive. */
export function hasInboxScopes(scope: string | null | undefined): boolean {
  const granted = new Set((scope ?? "").split(/\s+/).filter(Boolean));
  return INBOX_SCOPES.every((needed) => granted.has(needed));
}
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export class EmailNotConnectedError extends Error {
  constructor(message = "No Google account is connected for this company") {
    super(message);
    this.name = "EmailNotConnectedError";
  }
}

export class EmailSendError extends Error {
  /** Transient errors are worth retrying; hard ones are not (SPEC §10). */
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export function gmailConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export function dryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === "true";
}

export function oauthRedirectUri(origin: string): string {
  return `${origin}/api/email/google/callback`;
}

/** The consent URL. `prompt=consent` so a refresh token always comes back. */
export function authorizationUrl(options: {
  origin: string;
  state: string;
  /** Also ask for the inbox scopes, when the company is turning that on. */
  inbox?: boolean;
}): string {
  const scopes = [
    GMAIL_SEND_SCOPE,
    ...(options.inbox ? INBOX_SCOPES : []),
    "openid",
    "email",
  ];
  const params = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    redirect_uri: oauthRedirectUri(options.origin),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: options.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok) {
    throw new EmailSendError(
      json.error_description ?? json.error ?? `Token request failed (${response.status})`,
      response.status >= 500,
    );
  }
  return json;
}

/** Finish the OAuth dance and store the refresh token, encrypted. */
export async function connectMailbox(options: {
  companyId: string;
  code: string;
  origin: string;
  userId: string;
}) {
  const tokens = await postToken({
    code: options.code,
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
    redirect_uri: oauthRedirectUri(options.origin),
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    throw new EmailSendError(
      "Google did not return a refresh token. Remove this app's access in your Google account and connect again.",
      false,
    );
  }

  const profile = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const { email } = (await profile.json()) as { email?: string };

  const sealed = encryptSecret(tokens.refresh_token);

  // Switching provider clears the other one's credentials. A company that
  // moves from SMTP to Google must not leave a mailbox password sitting in the
  // row, both because it is no longer needed and because it is still a
  // password.
  const shared = {
    provider: "GOOGLE" as const,
    emailAddress: email ?? "unknown",
    refreshTokenCiphertext: sealed.ciphertext,
    encryptedDataKey: sealed.encryptedDataKey,
    scope: tokens.scope ?? GMAIL_SEND_SCOPE,
    connectedByUserId: options.userId,
    smtpHost: null,
    smtpPort: null,
    smtpUsername: null,
    smtpPasswordCiphertext: null,
    smtpPasswordKey: null,
    needsReconnectAt: null,
    lastError: null,
  };

  return prisma.emailConnection.upsert({
    where: { companyId: options.companyId },
    create: { companyId: options.companyId, ...shared },
    update: shared,
  });
}

export async function disconnectMailbox(companyId: string) {
  await prisma.emailConnection.deleteMany({ where: { companyId } });
}

/** Exchange the stored refresh token for a short-lived access token. */
async function accessTokenFor(companyId: string): Promise<{ token: string; from: string }> {
  const connection = await prisma.emailConnection.findUnique({ where: { companyId } });
  if (!connection) throw new EmailNotConnectedError();

  // Both columns are nullable now that a connection may be SMTP instead, and
  // an SMTP one has no token to refresh. Reaching here with either missing
  // means something asked Google to send for a mailbox Google knows nothing
  // about — a wiring mistake, not a user one.
  if (!connection.refreshTokenCiphertext || !connection.encryptedDataKey) {
    throw new EmailNotConnectedError(
      "This company is not connected to a Google mailbox.",
    );
  }

  const refreshToken = decryptSecret({
    ciphertext: connection.refreshTokenCiphertext,
    encryptedDataKey: connection.encryptedDataKey,
  });

  try {
    const tokens = await postToken({
      refresh_token: refreshToken,
      client_id: process.env.AUTH_GOOGLE_ID ?? "",
      client_secret: process.env.AUTH_GOOGLE_SECRET ?? "",
      grant_type: "refresh_token",
    });
    if (!tokens.access_token) throw new EmailSendError("Google returned no access token", true);
    return { token: tokens.access_token, from: connection.emailAddress };
  } catch (error) {
    // A revoked or expired grant is not a transient failure: the user has to
    // reconnect, and the UI must say so rather than failing silently.
    if (error instanceof EmailSendError && !error.transient) {
      await prisma.emailConnection.update({
        where: { companyId },
        data: { needsReconnectAt: new Date(), lastError: error.message },
      });
    }
    throw error;
  }
}

export async function connectedMailbox(companyId: string) {
  return prisma.emailConnection.findUnique({ where: { companyId } });
}

/** Send one message. Returns Gmail's message id. */
export async function sendViaGmail(options: {
  companyId: string;
  raw: string;
}): Promise<{ gmailMessageId: string; from: string }> {
  const { token, from } = await accessTokenFor(options.companyId);

  const response = await fetch(SEND_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: options.raw }),
  });

  if (!response.ok) {
    const detail = await response.text();
    // 429 and 5xx are worth retrying with backoff; 4xx generally is not.
    const transient = response.status === 429 || response.status >= 500;
    if (!transient) {
      await prisma.emailConnection.updateMany({
        where: { companyId: options.companyId },
        data: { lastError: `${response.status}: ${detail.slice(0, 300)}` },
      });
    }
    throw new EmailSendError(`Gmail rejected the message (${response.status}): ${detail.slice(0, 300)}`, transient);
  }

  const json = (await response.json()) as { id?: string };
  return { gmailMessageId: json.id ?? "unknown", from };
}

/**
 * An access token for this company's Google account, for the callers that
 * are not sending mail — the inbox poll and the Drive upload.
 *
 * Exported rather than duplicated: the refresh, the decryption and the
 * "mark it as needing a reconnect" behaviour are the same whichever API is
 * being called, and two copies of that would drift.
 */
export async function googleAccessToken(companyId: string): Promise<string> {
  const { token } = await accessTokenFor(companyId);
  return token;
}

/** The address mail would go out from, for previews. */
export async function senderAddress(companyId: string): Promise<string | null> {
  const connection = await prisma.emailConnection.findUnique({ where: { companyId } });
  return connection?.emailAddress ?? null;
}
