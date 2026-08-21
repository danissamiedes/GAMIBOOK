import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * Gmail sending (SPEC §10). Mail goes **from the user's own mailbox**, so it
 * lands in their Sent folder and replies come back to a person rather than to
 * a no-reply address.
 *
 * Only `gmail.send` is requested — the narrowest scope that works. This app
 * cannot read anyone's mail, and asking for a read scope to make some future
 * feature easier would be a poor trade.
 */

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
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
export function authorizationUrl(options: { origin: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: process.env.AUTH_GOOGLE_ID ?? "",
    redirect_uri: oauthRedirectUri(options.origin),
    response_type: "code",
    scope: `${GMAIL_SEND_SCOPE} openid email`,
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

  return prisma.emailConnection.upsert({
    where: { companyId: options.companyId },
    create: {
      companyId: options.companyId,
      emailAddress: email ?? "unknown",
      refreshTokenCiphertext: sealed.ciphertext,
      encryptedDataKey: sealed.encryptedDataKey,
      scope: tokens.scope ?? GMAIL_SEND_SCOPE,
      connectedByUserId: options.userId,
    },
    update: {
      emailAddress: email ?? "unknown",
      refreshTokenCiphertext: sealed.ciphertext,
      encryptedDataKey: sealed.encryptedDataKey,
      scope: tokens.scope ?? GMAIL_SEND_SCOPE,
      connectedByUserId: options.userId,
      needsReconnectAt: null,
      lastError: null,
    },
  });
}

export async function disconnectMailbox(companyId: string) {
  await prisma.emailConnection.deleteMany({ where: { companyId } });
}

/** Exchange the stored refresh token for a short-lived access token. */
async function accessTokenFor(companyId: string): Promise<{ token: string; from: string }> {
  const connection = await prisma.emailConnection.findUnique({ where: { companyId } });
  if (!connection) throw new EmailNotConnectedError();

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

/** The address mail would go out from, for previews. */
export async function senderAddress(companyId: string): Promise<string | null> {
  const connection = await prisma.emailConnection.findUnique({ where: { companyId } });
  return connection?.emailAddress ?? null;
}
