import { ConfigurationError } from "@/lib/errors";
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
    cached = new S3Adapter(bucket, {
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
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
