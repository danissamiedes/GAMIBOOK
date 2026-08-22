import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseFolderId } from "@/lib/drive/client";
import { setWatchedFolder, stopWatching, syncCompanyFolder } from "@/lib/drive/sync";
import { approveReceipt } from "@/lib/receipts/service";
import { money } from "@/lib/money";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const FOLDER = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

/** A private key good enough to sign with, generated once per run. */
function serviceAccountJson() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return JSON.stringify({
    client_email: "gamibook-drive@example.iam.gserviceaccount.com",
    private_key: privateKey,
  });
}

/**
 * Drive is mocked at the HTTP boundary. The point of these tests is the sync's
 * own behaviour — dedupe, error capture, what reaches the queue — not whether
 * Google's API works.
 */
function mockDrive(files: { id: string; name: string; link?: string }[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "test-token" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("googleapis.com/drive/v3/files")) {
      return new Response(
        JSON.stringify({
          files: files.map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: "image/jpeg",
            size: "12345",
            webViewLink: file.link ?? `https://drive.google.com/file/d/${file.id}/view`,
            createdTime: "2026-08-20T04:00:00.000Z",
          })),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("parseFolderId", () => {
  it("takes a folder URL, a shared URL, or the bare id", () => {
    expect(parseFolderId(`https://drive.google.com/drive/folders/${FOLDER}`)).toBe(FOLDER);
    expect(parseFolderId(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`)).toBe(
      FOLDER,
    );
    expect(parseFolderId(`  ${FOLDER}  `)).toBe(FOLDER);
    expect(parseFolderId(`https://drive.google.com/open?id=${FOLDER}`)).toBe(FOLDER);
  });

  it("refuses what is plainly not a folder", () => {
    expect(parseFolderId("")).toBeNull();
    expect(parseFolderId("   ")).toBeNull();
    expect(parseFolderId("my receipts")).toBeNull();
    expect(parseFolderId("short")).toBeNull();
  });
});

describe("watching a Drive folder", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT = serviceAccountJson();
    fixture = await makeCompanyWithChart("Drive Co");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
    await prisma.$disconnect();
  });

  it("saves the folder after proving it can reach it", async () => {
    mockDrive([]);
    const watch = await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: `https://drive.google.com/drive/folders/${FOLDER}`,
      folderName: "Receipts 2026",
    });

    expect(watch.folderId).toBe(FOLDER);
    expect(watch.folderName).toBe("Receipts 2026");
  });

  it("refuses a folder it cannot reach, and saves nothing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("token")) {
        return new Response(JSON.stringify({ access_token: "t" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    });

    await expect(
      setWatchedFolder({
        companyId: fixture.company.id,
        userId: owner.id,
        folderInput: FOLDER,
      }),
    ).rejects.toThrow(/shared with the service account/);

    expect(await prisma.driveWatch.count()).toBe(0);
  });

  it("queues each image once, however often it scans", async () => {
    mockDrive([]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    vi.restoreAllMocks();

    mockDrive([
      { id: "file-a", name: "grab.jpg" },
      { id: "file-b", name: "fuel.jpg" },
    ]);

    const first = await syncCompanyFolder(fixture.company.id);
    expect(first).toEqual({ queued: 2, seen: 2 });

    // The folder has not changed; a second scan must add nothing.
    const second = await syncCompanyFolder(fixture.company.id);
    expect(second).toEqual({ queued: 0, seen: 2 });
    expect(await prisma.receiptUpload.count()).toBe(2);

    const queued = await prisma.receiptUpload.findMany({ orderBy: { filename: "asc" } });
    expect(queued.map((r) => r.filename)).toEqual(["fuel.jpg", "grab.jpg"]);
    expect(queued.every((r) => r.source === "GOOGLE_DRIVE")).toBe(true);
    // Linked, never copied.
    expect(queued.every((r) => r.fileKey === null)).toBe(true);
    expect(queued[0].sourceUrl).toContain("drive.google.com");
  });

  it("picks up only what is new on a later scan", async () => {
    mockDrive([]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    vi.restoreAllMocks();

    mockDrive([{ id: "file-a", name: "one.jpg" }]);
    await syncCompanyFolder(fixture.company.id);
    vi.restoreAllMocks();

    mockDrive([
      { id: "file-a", name: "one.jpg" },
      { id: "file-b", name: "two.jpg" },
    ]);
    expect(await syncCompanyFolder(fixture.company.id)).toEqual({ queued: 1, seen: 2 });
    expect(await prisma.receiptUpload.count()).toBe(2);
  });

  it("records why a scan failed instead of losing it", async () => {
    mockDrive([]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    vi.restoreAllMocks();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("token")) {
        return new Response(JSON.stringify({ access_token: "t" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("gone", { status: 404 });
    });

    await expect(syncCompanyFolder(fixture.company.id)).rejects.toThrow();
    const watch = await prisma.driveWatch.findUniqueOrThrow({
      where: { companyId: fixture.company.id },
    });
    expect(watch.lastError).toMatch(/not found/i);
    expect(watch.lastSyncAt).not.toBeNull();
  });

  it("does nothing for a company that watches no folder", async () => {
    expect(await syncCompanyFolder(fixture.company.id)).toEqual({ queued: 0, seen: 0 });
  });

  it("carries the Drive link onto the expense when approved", async () => {
    mockDrive([]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    vi.restoreAllMocks();

    mockDrive([{ id: "file-a", name: "taxi.jpg", link: "https://drive.google.com/file/d/file-a/view" }]);
    await syncCompanyFolder(fixture.company.id);
    const receipt = await prisma.receiptUpload.findFirstOrThrow();

    const { expense } = await approveReceipt({
      companyId: fixture.company.id,
      receiptId: receipt.id,
      kind: "DIRECT",
      date: new Date(Date.UTC(2026, 7, 20)),
      amount: "640.00",
      currency: "PHP",
      description: "Taxi",
      expenseAccountId: fixture.code("6300").id,
      paymentAccountId: fixture.code("1000").id,
      userId: owner.id,
      role: "OWNER",
    });

    expect(expense.receiptUrl).toBe("https://drive.google.com/file/d/file-a/view");
    // Nothing was copied in, so there is no storage key to point at.
    expect(expense.receiptFileKey).toBeNull();
    expect(money(expense.amount).toFixed(2)).toBe("640.00");
  });

  it("stops watching without touching what is already queued", async () => {
    mockDrive([{ id: "file-a", name: "one.jpg" }]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    await syncCompanyFolder(fixture.company.id);
    expect(await prisma.receiptUpload.count()).toBe(1);

    await stopWatching(fixture.company.id, owner.id);
    expect(await prisma.driveWatch.count()).toBe(0);
    expect(await prisma.receiptUpload.count()).toBe(1);
  });

  it("keeps two companies' folders apart", async () => {
    const other = await makeCompanyWithChart("Other Co");
    const otherOwner = await makeUser("OWNER", other.company.id);

    mockDrive([{ id: "shared-file", name: "same.jpg" }]);
    await setWatchedFolder({
      companyId: fixture.company.id,
      userId: owner.id,
      folderInput: FOLDER,
    });
    await setWatchedFolder({
      companyId: other.company.id,
      userId: otherOwner.id,
      folderInput: FOLDER,
    });

    await syncCompanyFolder(fixture.company.id);
    await syncCompanyFolder(other.company.id);

    // The same Drive file id in both companies is two separate receipts —
    // the unique index is scoped per company, not global.
    expect(await prisma.receiptUpload.count({ where: { companyId: fixture.company.id } })).toBe(1);
    expect(await prisma.receiptUpload.count({ where: { companyId: other.company.id } })).toBe(1);
  });
});

describe("driveConfigured", () => {
  it("is off without a key and on with one", async () => {
    vi.resetModules();
    const previous = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
    delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;

    const mod = await import("@/lib/drive/client");
    expect(mod.driveConfigured()).toBe(false);
    expect(mod.driveServiceAccountEmail()).toBeNull();

    process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT = JSON.stringify({
      client_email: "robot@example.iam.gserviceaccount.com",
      private_key: "not-a-real-key",
    });
    expect(mod.driveConfigured()).toBe(true);
    expect(mod.driveServiceAccountEmail()).toBe("robot@example.iam.gserviceaccount.com");

    if (previous) process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT = previous;
    else delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT;
  });
});
