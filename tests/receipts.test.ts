import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveReceipt,
  dismissReceipt,
  restoreReceipt,
  uploadReceipt,
} from "@/lib/receipts/service";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/accounts";
import { accountBalance } from "@/lib/ledger/reports";
import { money } from "@/lib/money";
import { resetStorage, storage } from "@/lib/storage";
import { makeCompanyWithChart, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const AUG = new Date(Date.UTC(2026, 7, 15));
const AS_OF = new Date(Date.UTC(2026, 11, 31));
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The receipt inbox. The reader itself is not exercised here — it is a network
 * call to someone else's model, and a test that depended on what it returns
 * would be testing Anthropic rather than this code. What matters is that a
 * photo never reaches the ledger until a person approves figures, and that
 * approving posts exactly the expense those figures describe.
 */
describe("receipt inbox", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  const balance = (code: string) =>
    accountBalance({ companyId: fixture.company.id, accountId: fixture.code(code).id, asOf: AS_OF });

  async function upload(filename = "receipt.png") {
    return uploadReceipt({
      companyId: fixture.company.id,
      userId: owner.id,
      filename,
      mimeType: "image/png",
      bytes: PIXEL,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    resetStorage();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = "./storage-test";
    fixture = await makeCompanyWithChart("Receipt Co");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores the photo and queues it, touching no account", async () => {
    const receipt = await upload();

    expect(receipt.status).toBe("PENDING");
    expect(receipt.fileKey).toContain(fixture.company.id);
    expect(await storage().exists(receipt.fileKey)).toBe(true);
    expect(await prisma.journalEntry.count()).toBe(0);
    expect(await prisma.expense.count()).toBe(0);
  });

  it("refuses an empty file, an oversized one and a non-image", async () => {
    await expect(
      uploadReceipt({
        companyId: fixture.company.id,
        userId: owner.id,
        filename: "empty.png",
        mimeType: "image/png",
        bytes: Buffer.alloc(0),
      }),
    ).rejects.toThrow(/empty/);

    await expect(
      uploadReceipt({
        companyId: fixture.company.id,
        userId: owner.id,
        filename: "huge.png",
        mimeType: "image/png",
        bytes: Buffer.alloc(9 * 1024 * 1024),
      }),
    ).rejects.toThrow(/limit is 8 MB/);

    await expect(
      uploadReceipt({
        companyId: fixture.company.id,
        userId: owner.id,
        filename: "notes.pdf",
        mimeType: "application/pdf",
        bytes: PIXEL,
      }),
    ).rejects.toThrow(/Receipts are images/);
  });

  it("approves into a direct expense and posts it", async () => {
    const receipt = await upload();

    const { expense } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      kind: "DIRECT",
      date: AUG,
      amount: "1780.00",
      currency: "PHP",
      description: "Taxi to client",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(money(expense.amount).toFixed(2)).toBe("1780.00");
    expect(expense.status).toBe("PAID");
    // The photo travels with the expense rather than being copied.
    expect(expense.receiptFileKey).toBe(receipt.fileKey);
    expect((await balance("6300")).toFixed(2)).toBe("1780.00");
    expect((await balance("1000")).toFixed(2)).toBe("-1780.00");

    const after = await prisma.receiptUpload.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(after.status).toBe("APPROVED");
    expect(after.expenseId).toBe(expense.id);
  });

  it("approves into a bill, which owes the vendor", async () => {
    const vendor = await makeVendor(fixture.company.id, "REGULAR");
    const receipt = await upload();

    const { expense } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      kind: "BILL",
      date: AUG,
      amount: "2500.00",
      currency: "PHP",
      description: "Office supplies",
      expenseAccountId: fixture.code("6100").id,
      vendorId: vendor.id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(expense.status).toBe("APPROVED");
    expect(money(expense.balanceDue).toFixed(2)).toBe("2500.00");
    expect(
      (
        await accountBalance({
          companyId: fixture.company.id,
          accountId: fixture.system(SYSTEM_ACCOUNTS.ACCOUNTS_PAYABLE).id,
          asOf: AS_OF,
        })
      ).toFixed(2),
    ).toBe("2500.00");
  });

  it("records the figures it was given, not the ones that were read", async () => {
    const receipt = await upload();
    // A misread total sitting on the row.
    await prisma.receiptUpload.update({
      where: { id: receipt.id },
      data: { status: "READY", readAmount: "1180.00", readDescription: "Wrong" },
    });

    const { expense } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      kind: "DIRECT",
      date: AUG,
      amount: "1780.00",
      currency: "PHP",
      description: "Corrected by hand",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(money(expense.amount).toFixed(2)).toBe("1780.00");
    expect(expense.description).toBe("Corrected by hand");
  });

  it("will not approve the same receipt twice", async () => {
    const receipt = await upload();
    const approve = () =>
      approveReceipt({
        companyId: fixture.company.id,
        receiptId: receipt.id,
        kind: "DIRECT",
        date: AUG,
        amount: "100.00",
        currency: "PHP",
        description: "Once",
        expenseAccountId: fixture.code("6300").id,
        paymentAccountId: fixture.code("1000").id,
        userId: owner.id,
        role: "OWNER",
      });

    await approve();
    await expect(approve()).rejects.toThrow(/already been entered/);
    expect(await prisma.expense.count()).toBe(1);
  });

  it("dismisses and restores without deleting anything", async () => {
    const receipt = await upload();

    const dismissed = await dismissReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      reason: "Personal, not the company's",
      userId: owner.id,
    });
    expect(dismissed.status).toBe("DISMISSED");
    expect(dismissed.dismissedReason).toBe("Personal, not the company's");
    expect(await storage().exists(receipt.fileKey)).toBe(true);

    const restored = await restoreReceipt(fixture.company.id, receipt.id);
    expect(restored.status).toBe("PENDING");
    expect(restored.dismissedAt).toBeNull();
  });

  it("will not dismiss one that is already an expense", async () => {
    const receipt = await upload();
    await approveReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      kind: "DIRECT",
      date: AUG,
      amount: "100.00",
      currency: "PHP",
      description: "Done",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      userId: owner.id,
      role: "OWNER",
    });

    await expect(
      dismissReceipt({ companyId: fixture.company.id, receiptId: receipt.id, userId: owner.id }),
    ).rejects.toThrow(/already an expense/);
  });

  it("will not reach a receipt in another company", async () => {
    const other = await makeCompanyWithChart("Other Co");
    const receipt = await upload();

    await expect(
      approveReceipt({
        companyId: other.company.id,
        receiptId: receipt.id,
        kind: "DIRECT",
        date: AUG,
        amount: "100.00",
        currency: "PHP",
        description: "Theirs",
        expenseAccountId: other.code("6300").id,
        paymentAccountId: other.code("1000").id,
        userId: owner.id,
        role: "OWNER",
      }),
    ).rejects.toThrow(/not found in this company/);
  });
});

describe("readReceipt", () => {
  it("names the missing setting rather than failing on an undefined client", async () => {
    vi.resetModules();
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { readReceipt } = await import("@/lib/receipts/extract");

    await expect(
      readReceipt({ bytes: PIXEL, mimeType: "image/png" }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);

    if (previous) process.env.ANTHROPIC_API_KEY = previous;
  });

  it("refuses a format the reader cannot take", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    const { readReceipt } = await import("@/lib/receipts/extract");

    await expect(
      readReceipt({ bytes: PIXEL, mimeType: "image/tiff" }),
    ).rejects.toThrow(/cannot be read/);

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("readerConfigured", () => {
  it("is off without a key and on with one", async () => {
    vi.resetModules();
    const previous = process.env.ANTHROPIC_API_KEY;

    delete process.env.ANTHROPIC_API_KEY;
    const off = await import("@/lib/receipts/extract");
    expect(off.readerConfigured()).toBe(false);

    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    expect(off.readerConfigured()).toBe(true);

    if (previous) process.env.ANTHROPIC_API_KEY = previous;
    else delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("a typed-in file link", () => {
  it("is kept on the expense, and only if it is a real web link", async () => {
    await resetDatabase();
    resetStorage();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = "./storage-test";
    const fixture = await makeCompanyWithChart("Link Co");
    const owner = await makeUser("OWNER", fixture.company.id);

    const good = await uploadReceipt({
      companyId: fixture.company.id,
      userId: owner.id,
      filename: "a.png",
      mimeType: "image/png",
      bytes: PIXEL,
    });
    const { expense } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: good.id,
      kind: "DIRECT",
      date: new Date(Date.UTC(2026, 7, 15)),
      amount: "100.00",
      currency: "PHP",
      description: "With a link",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      fileUrl: "https://drive.google.com/file/d/abc123/view",
      userId: owner.id,
      role: "OWNER",
    });
    expect(expense.receiptUrl).toBe("https://drive.google.com/file/d/abc123/view");
    // The photo is kept too — a link is not a substitute for the evidence.
    expect(expense.receiptFileKey).toBe(good.fileKey);

    const bad = await uploadReceipt({
      companyId: fixture.company.id,
      userId: owner.id,
      filename: "b.png",
      mimeType: "image/png",
      bytes: PIXEL,
    });
    const { expense: second } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: bad.id,
      kind: "DIRECT",
      date: new Date(Date.UTC(2026, 7, 15)),
      amount: "100.00",
      currency: "PHP",
      description: "With a nasty link",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      // A scheme that would run as script the moment somebody clicked it.
      fileUrl: "javascript:alert(document.cookie)",
      userId: owner.id,
      role: "OWNER",
    });
    expect(second.receiptUrl).toBeNull();
  });
});
