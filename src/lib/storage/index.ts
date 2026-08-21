import { LocalDiskAdapter } from "./local";
import { S3Adapter } from "./s3";
import type { StorageAdapter } from "./types";

export type { StorageAdapter } from "./types";
export { LocalDiskAdapter } from "./local";
export { S3Adapter } from "./s3";

let cached: StorageAdapter | undefined;

/** Chosen by env var, per SPEC §13. Nothing else picks a driver. */
export function storage(): StorageAdapter {
  if (cached) return cached;

  const driver = (process.env.STORAGE_DRIVER ?? "local").toLowerCase();

  if (driver === "s3") {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
    cached = new S3Adapter(bucket, {
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
    return cached;
  }

  if (driver !== "local") throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);

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
