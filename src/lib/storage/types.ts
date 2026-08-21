/**
 * Every read and write of a file goes through this interface (SPEC §13).
 * No code outside an adapter touches a path or a bucket.
 *
 * Receipts, logos and uploaded import files are durable. Generated PDFs are a
 * cache — regenerable from the document, so losing the volume never loses
 * financial data.
 */
export interface StorageAdapter {
  readonly name: string;
  put(key: string, body: Buffer | Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Rejects traversal and absolute keys before they reach any filesystem. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\0")) {
    throw new Error(`Unsafe storage key: ${JSON.stringify(key)}`);
  }
}
