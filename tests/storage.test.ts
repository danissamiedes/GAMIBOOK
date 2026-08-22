import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigurationError, StorageUnavailableError } from "@/lib/errors";
import { LocalDiskAdapter, resetStorage, storage, storageKeys, withStorage } from "@/lib/storage";

describe("local disk storage adapter", () => {
  let root: string;
  let adapter: LocalDiskAdapter;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "ledger-storage-"));
    adapter = new LocalDiskAdapter(root);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("puts, gets, lists and deletes", async () => {
    const key = storageKeys.receipt("company-1", "expense-1", "receipt.pdf");
    await adapter.put(key, Buffer.from("hello"));

    expect(await adapter.exists(key)).toBe(true);
    expect((await adapter.get(key)).toString()).toBe("hello");
    expect(await adapter.list("companies/company-1")).toEqual([key]);

    await adapter.delete(key);
    expect(await adapter.exists(key)).toBe(false);
  });

  it("deleting something absent is not an error", async () => {
    await expect(adapter.delete("companies/x/nothing.pdf")).resolves.toBeUndefined();
  });

  it("refuses traversal and absolute keys", async () => {
    await expect(adapter.put("../escape.txt", Buffer.from("x"))).rejects.toThrow(/Unsafe/);
    await expect(adapter.put("/etc/passwd", Buffer.from("x"))).rejects.toThrow(/Unsafe/);
    await expect(adapter.get("companies/../../etc/passwd")).rejects.toThrow(/Unsafe/);
  });

  it("namespaces every key by company", () => {
    expect(storageKeys.companyLogo("c1", "logo.png")).toBe("companies/c1/branding/logo.png");
    expect(storageKeys.importFile("c1", "b1", "wo.xlsx")).toBe("companies/c1/imports/b1/wo.xlsx");
    expect(storageKeys.documentPdf("c1", "work-order", "w1")).toBe(
      "companies/c1/pdf/work-order/w1.pdf",
    );
  });
});

describe("choosing a driver", () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
    resetStorage();
  });

  /**
   * The refusal has to reach the operator, not just the log. It is thrown as a
   * ConfigurationError so the download route and the email actions can tell
   * them which setting is wrong instead of returning a bare 500 — which is
   * exactly what happened: a PDF download 500'd and the reason was only ever
   * in the server log.
   */
  it("refuses the local driver on a serverless host rather than losing files quietly", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    resetStorage();
    expect(() => storage()).toThrow(ConfigurationError);
    expect(() => storage()).toThrow(/STORAGE_DRIVER/);
    // The message has to name what to do, not merely that something is wrong.
    expect(() => storage()).toThrow(/S3_BUCKET/);
  });

  it("still allows the local driver on a host with a real filesystem", () => {
    delete process.env.VERCEL;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.SERVERLESS;
    process.env.STORAGE_DRIVER = "local";
    resetStorage();
    expect(storage().name).toBe("local");
  });

  it("allows s3 on a serverless host, which is the supported combination", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "s3";
    process.env.S3_BUCKET = "ledger-test";
    resetStorage();
    expect(storage().name).toBe("s3");
  });

  it("will not accept s3 without a bucket", () => {
    process.env.STORAGE_DRIVER = "s3";
    delete process.env.S3_BUCKET;
    resetStorage();
    expect(() => storage()).toThrow(ConfigurationError);
    expect(() => storage()).toThrow(/S3_BUCKET/);
  });
});

describe("withStorage", () => {
  it("returns the value when the call succeeds", async () => {
    expect(await withStorage("upload", async () => "done")).toBe("done");
  });

  it("re-labels a driver failure so the message names the settings to check", async () => {
    const thrown = await withStorage("upload", async () => {
      throw new Error("The specified bucket does not exist");
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageUnavailableError);
    expect(thrown).toBeInstanceOf(ConfigurationError);
    const message = (thrown as Error).message;
    expect(message).toContain("rejected the upload");
    expect(message).toContain("S3_BUCKET");
    expect(message).toContain("The specified bucket does not exist");
  });

  it("passes a ConfigurationError through untouched", async () => {
    const original = new ConfigurationError("STORAGE_DRIVER=s3 requires S3_BUCKET to be set.");
    const thrown = await withStorage("upload", async () => {
      throw original;
    }).catch((error: unknown) => error);

    expect(thrown).toBe(original);
  });
});
