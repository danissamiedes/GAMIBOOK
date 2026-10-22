import { prisma } from "@/lib/db";
import { ConfigurationError } from "@/lib/errors";
import { googleAccessToken } from "@/lib/email/gmail";

/**
 * Google Drive, used for one thing: parking the attachments off forwarded
 * bills (SPEC §8.2 extension).
 *
 * The bytes go from the mailbox to Drive and are never written to this
 * server — which is the point. What GAMIBOOK keeps is the link, so the file
 * is the company's, in their own Drive, openable and shareable like anything
 * else they own, and nothing here grows as the paperwork does.
 *
 * The scope is `drive.file`, the narrow one: this app can only see files it
 * created itself. It cannot read the rest of the Drive, and a folder somebody
 * moves or renames by hand goes on working because Drive is asked by id.
 */

const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";
const FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export class DriveError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

async function driveFetch(token: string, url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new DriveError(
      `Drive refused the request (${response.status}): ${detail}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return response;
}

/**
 * The folder this company's forwarded bills go in, made on first use.
 *
 * Remembered on the company so they stay together rather than scattering a
 * new folder per message. If the remembered one has been deleted, a fresh
 * one is made — a folder somebody tidied away should not stop tomorrow's
 * bill being filed.
 */
export async function inboxFolderId(companyId: string, companyName: string): Promise<string> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { inboxDriveFolderId: true },
  });

  const token = await googleAccessToken(companyId);

  if (company.inboxDriveFolderId) {
    const check = await fetch(
      `${FILES_ENDPOINT}/${company.inboxDriveFolderId}?fields=id,trashed`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (check.ok) {
      const found = (await check.json()) as { trashed?: boolean };
      if (!found.trashed) return company.inboxDriveFolderId;
    }
  }

  const created = await driveFetch(token, `${FILES_ENDPOINT}?fields=id`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `GAMIBOOK — ${companyName} bills by email`,
      mimeType: FOLDER_MIME,
    }),
  });
  const { id } = (await created.json()) as { id: string };

  await prisma.company.update({
    where: { id: companyId },
    data: { inboxDriveFolderId: id },
  });
  return id;
}

export type DriveUpload = { fileId: string; viewUrl: string };

/**
 * Put one file in the folder and hand back the link that opens it.
 *
 * Multipart rather than resumable: a bill is a photograph or a PDF, and the
 * complexity of resumable uploads buys nothing at that size. Anything large
 * enough to need it is refused by the caller before it gets here.
 */
export async function uploadToDrive(options: {
  companyId: string;
  folderId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}): Promise<DriveUpload> {
  const token = await googleAccessToken(options.companyId);
  const boundary = `gamibook-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: options.filename,
    parents: [options.folderId],
  });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\ncontent-type: ${options.mimeType || "application/octet-stream"}\r\n\r\n`,
    ),
    options.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await driveFetch(
    token,
    `${UPLOAD_ENDPOINT}?uploadType=multipart&fields=id,webViewLink`,
    {
      method: "POST",
      headers: { "content-type": `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    },
  );

  const file = (await response.json()) as { id: string; webViewLink?: string };
  return {
    fileId: file.id,
    // Drive always has a view link; falling back to the canonical form keeps
    // a row openable even if the field is omitted.
    viewUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
  };
}

/** Whether the deployment can talk to Google at all. */
export function driveConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export function requireDrive(): void {
  if (!driveConfigured()) {
    throw new ConfigurationError(
      "Google is not configured for this deployment, so attachments cannot be filed to Drive. " +
        "Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET, then connect the mailbox again.",
    );
  }
}
