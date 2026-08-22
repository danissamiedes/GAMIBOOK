import { ConfigurationError, StorageUnavailableError } from "@/lib/errors";
import { LocalDiskAdapter } from "./local";
import { S3Adapter } from "./s3";
import type { StorageAdapter } from "./types";

export type { StorageAdapter } from "./types";
export { LocalDiskAdapter } from "./local";
export { S3Adapter } from "./s3";

let cached: StorageAdapter | undefined;

/**
 * True on a host that throws the filesystem away between requests. VERCEL and
 * AWS_LAMBDA_FUNCTION_NAME are set by the platforms themselves; SERVERLESS is
 * the manual override for anywhere else that behaves the same way.
 */
function isServerless(): boolean {
  return Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.SERVERLESS === "true",
  );
}

/** Chosen by env var, per SPEC §13. Nothing else picks a driver. */
export function storage(): StorageAdapter {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();

  if (driver === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new ConfigurationError("STORAGE_DRIVER=s3 requires S3_BUCKET to be set.");
    const endpoint = process.env.S3_ENDPOINT;
    cached = new S3Adapter(bucket, {
      region: process.env.S3_REGION,
      endpoint,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: pathStyle(process.env.S3_FORCE_PATH_STYLE, endpoint),
    });
    return cached;
  }

  if (driver !== "local") throw new ConfigurationError(`Unknown STORAGE_DRIVER: ${driver}. Use "local" or "s3".`);

  // A serverless instance has a writable /tmp and nothing else, and that /tmp
  // goes away with the instance. Writing there would "work" — every call
  // succeeds — and receipts and uploaded bank statements would disappear
  // between requests with nothing to show for it. Refuse instead: a deployment
  // that will not start is a far smaller problem than books missing their
  // source documents.
  if (isServerless()) {
    throw new ConfigurationError(
      "File storage is not set up for this deployment. STORAGE_DRIVER is \"local\", " +
        "and a serverless filesystem does not survive between requests — receipts and " +
        "generated PDFs would be accepted and then lost. Set STORAGE_DRIVER=s3 along " +
        "with S3_BUCKET, S3_ENDPOINT, S3_REGION and the access key pair, then redeploy.",
    );
  }

  cached = new LocalDiskAdapter(process.env.STORAGE_LOCAL_PATH ?? "./storage");
  return cached;
}

/**
 * Runs a storage call and re-labels anything the driver throws, so a rejected
 * bucket or key pair arrives as something an operator can act on rather than a
 * bare 500. A `ConfigurationError` already names its setting and passes through.
 */
export async function withStorage<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof ConfigurationError) throw thrown;
    throw new StorageUnavailableError(operation, thrown);
  }
}


/**
 * Whether to address the bucket by path (`host/bucket/key`) rather than by
 * subdomain (`bucket.host/key`).
 *
 * Default it on whenever a custom endpoint is set, because every S3-compatible
 * service that is not AWS needs it — and the failure when it is missing is
 * genuinely undiagnosable. Subdomain addressing asks for
 * `ledger-files.abcd.supabase.co`, Supabase's certificate covers
 * `*.supabase.co`, and a wildcard matches exactly one label, so the server
 * cannot answer for that name and aborts the TLS handshake. What reaches the
 * screen is `SSL alert number 40` from inside OpenSSL, which says nothing about
 * buckets, subdomains or the setting that caused it.
 *
 * An explicit value always wins, and is read loosely: someone who typed `TRUE`
 * or `1` meant yes, and silently treating that as no is how they end up back at
 * the handshake error.
 */
export function pathStyle(value: string | undefined, endpoint: string | undefined): boolean {
  const explicit = (value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(explicit)) return true;
  if (["false", "0", "no", "off"].includes(explicit)) return false;
  return Boolean(endpoint);
}

/** Test seam only. */
export function resetStorage(): void {
  cached = undefined;
}

/** Keys are namespaced by company so one company's files never collide. */
export const storageKeys = {
  companyLogo: (companyId: string, filename: string) => `companies/${companyId}/branding/${filename}`,
  receipt: (companyId: string, expenseId: string, filename: string) =>
    `companies/${companyId}/receipts/${expenseId}/${filename}`,
  importFile: (companyId: string, batchId: string, filename: string) =>
    `companies/${companyId}/imports/${batchId}/${filename}`,
  documentPdf: (companyId: string, kind: string, id: string) =>
    `companies/${companyId}/pdf/${kind}/${id}.pdf`,
};
