import { createSign } from "node:crypto";
import { ConfigurationError } from "@/lib/errors";

/**
 * Google Drive, reached as a service account (SPEC §8.2 extension).
 *
 * A service account rather than somebody's OAuth grant, because the only Drive
 * scope that can read an arbitrary folder is `drive.readonly` — which over a
 * person's account means the whole of their Drive. A service account sees
 * exactly what has been shared with it and nothing else, so sharing one folder
 * grants access to one folder.
 *
 * Hand-rolled against the REST API, like the Gmail integration next door. The
 * `googleapis` package is tens of megabytes to make two calls.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export class DriveError extends Error {
  readonly transient: boolean;

  constructor(message: string, transient = false) {
    super(message);
    this.name = "DriveError";
    this.transient = transient;
  }
}

type ServiceAccount = { client_email: string; private_key: string };

/**
 * The key, from the environment. Accepts the raw JSON Google hands you or a
 * base64 copy of it, because a private key's newlines survive one of those
 * two much more reliably than the other depending on where it is pasted.
 */
function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
  if (!raw?.trim()) {
    throw new ConfigurationError(
      "Google Drive is not set up. Put the service account's JSON key in " +
        "GOOGLE_DRIVE_SERVICE_ACCOUNT in the deployment's settings, then redeploy.",
    );
  }

  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(text) as Partial<ServiceAccount>;
  } catch {
    throw new ConfigurationError(
      "GOOGLE_DRIVE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file, " +
        "or a base64 copy of it.",
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new ConfigurationError(
      "GOOGLE_DRIVE_SERVICE_ACCOUNT is missing client_email or private_key. " +
        "That is the service account key file, not the OAuth client.",
    );
  }
  // A key pasted through a form often arrives with its newlines escaped.
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

export function driveConfigured(): boolean {
  return Boolean(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT?.trim());
}

/** The address to share the folder with. Shown on the settings screen. */
export function driveServiceAccountEmail(): string | null {
  try {
    return serviceAccount().client_email;
  } catch {
    return null;
  }
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

/**
 * A signed assertion exchanged for an access token. Google's two-legged flow:
 * no user, no refresh token, nothing to store — the key signs a fresh JWT each
 * time and the token lives an hour.
 */
async function accessToken(): Promise<string> {
  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);

  const claims = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify(claims),
  )}`;

  let signature: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(account.private_key, "base64url");
  } catch {
    throw new ConfigurationError(
      "The Google Drive service account key could not sign a request. The " +
        "private_key in GOOGLE_DRIVE_SERVICE_ACCOUNT looks damaged — re-paste the key file.",
    );
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new DriveError(
      `Google refused the service account (${response.status}): ${detail.slice(0, 300)}`,
      response.status >= 500,
    );
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new DriveError("Google returned no access token");
  return body.access_token;
}

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  webViewLink: string | null;
  createdTime: string;
};

/**
 * Every image in a folder, oldest first.
 *
 * Deliberately lists the whole folder rather than only what is new: the caller
 * dedupes on the file id, which is the only thing that stays true when a file
 * is renamed, re-uploaded or its timestamps shift. A "since last sync" filter
 * quietly misses a file that arrives while a scan is running.
 */
export async function listFolderImages(
  folderId: string,
  options: { max?: number } = {},
): Promise<DriveFile[]> {
  const token = await accessToken();
  const max = options.max ?? 200;
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(DRIVE_FILES);
    url.searchParams.set(
      "q",
      `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType contains 'image/'`,
    );
    url.searchParams.set(
      "fields",
      "nextPageToken,files(id,name,mimeType,size,webViewLink,createdTime)",
    );
    url.searchParams.set("orderBy", "createdTime");
    url.searchParams.set("pageSize", String(Math.min(100, max - files.length)));
    // A folder in a shared drive is invisible without both of these.
    url.searchParams.set("supportsAllDrives", "true");
    url.searchParams.set("includeItemsFromAllDrives", "true");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 404) {
        throw new DriveError(
          "That folder was not found. Check the folder ID, and that the folder is " +
            "shared with the service account.",
        );
      }
      if (response.status === 403) {
        throw new DriveError(
          "Google refused access to that folder. Share it with the service account " +
            "address, as Viewer is enough.",
        );
      }
      throw new DriveError(
        `Google Drive returned ${response.status}: ${detail.slice(0, 300)}`,
        response.status >= 500,
      );
    }

    const body = (await response.json()) as {
      nextPageToken?: string;
      files?: { id: string; name: string; mimeType: string; size?: string; webViewLink?: string; createdTime: string }[];
    };
    for (const file of body.files ?? []) {
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size ? Number(file.size) : null,
        webViewLink: file.webViewLink ?? null,
        createdTime: file.createdTime,
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken && files.length < max);

  return files;
}

/** The bytes of one file. Used to read a receipt, never to keep a copy. */
export async function downloadFile(fileId: string): Promise<Buffer> {
  const token = await accessToken();
  const url = new URL(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new DriveError(
      `Could not download that file from Drive (${response.status})`,
      response.status >= 500,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The folder id out of whatever someone pasted — a full URL or the id itself.
 * Nobody should have to know which part of a Drive URL is the id.
 */
export function parseFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fromUrl = /\/folders\/([A-Za-z0-9_-]+)/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  const fromQuery = /[?&]id=([A-Za-z0-9_-]+)/.exec(trimmed);
  if (fromQuery) return fromQuery[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(trimmed) ? trimmed : null;
}
