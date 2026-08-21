import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalDiskAdapter, resetStorage, storage, storageKeys } from "@/lib/storage";

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

  it("refuses the local driver on a serverless host rather than losing files quietly", () => {
    process.env.VERCEL = "1";
    process.env.STORAGE_DRIVER = "local";
    resetStorage();
    expect(() => storage()).toThrow(/serverless/i);
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
    expect(() => storage()).toThrow(/S3_BUCKET/);
  });
});
