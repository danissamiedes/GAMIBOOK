import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@/lib/email/crypto";
import { hasInboxScopes, GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/email/gmail";
import {
  dismissInboxMessage,
  inboxEnabledCompanies,
  markInboxRecorded,
  pollCompanyInbox,
  restoreInboxMessage,
  runInboxPoll,
} from "@/lib/receipts/inbox";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

/**
 * Bills forwarded by email (SPEC §8.2 extension).
 *
 * Google is stubbed at `fetch`, which is the only boundary this code has to
 * the outside: everything above it — what counts as an attachment worth
 * keeping, filing a message once, parking the bytes in Drive and never on
 * this server — is ours and is what these assert.
 */

const ADDRESS = "docs+kasagami@bookkeepingpoint.com";

/** A Gmail message payload with one PDF attached, as the API returns it. */
function gmailMessage(options: {
  id: string;
  subject?: string;
  attachments?: { filename: string; mimeType: string; size: number }[];
}) {
  return {
    id: options.id,
    snippet: "Please find attached",
    internalDate: String(Date.UTC(2026, 9, 14, 9, 30)),
    payload: {
      headers: [
        { name: "Subject", value: options.subject ?? "Invoice 4471 from Davao Light" },
        { name: "From", value: "billing@davaolight.test" },
        { name: "Delivered-To", value: ADDRESS },
      ],
      parts: [
        { mimeType: "text/plain", body: { size: 40, data: "" } },
        ...(options.attachments ?? [
          { filename: "invoice-4471.pdf", mimeType: "application/pdf", size: 52_000 },
        ]).map((file, index) => ({
          filename: file.filename,
          mimeType: file.mimeType,
          body: { attachmentId: `att-${options.id}-${index}`, size: file.size },
        })),
      ],
    },
  };
}

type Stub = {
  messages: ReturnType<typeof gmailMessage>[];
  calls: { url: string; method: string }[];
  driveUploads: number;
  labelled: string[];
};

/**
 * Stand in for Google. Only the handful of endpoints this feature touches
 * answer; anything else throws, so a call nobody meant to make is a failure
 * rather than an undefined read somewhere downstream.
 */
function stubGoogle(stub: Stub) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    stub.calls.push({ url, method });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "test-access-token", expires_in: 3600 });
    }
    if (url.includes("/users/me/messages?q=")) {
      return json({ messages: stub.messages.map((message) => ({ id: message.id })) });
    }
    if (/\/users\/me\/messages\/[^/?]+\?format=full/.test(url)) {
      const id = /messages\/([^/?]+)/.exec(url)![1];
      const found = stub.messages.find((message) => message.id === id);
      return found ? json(found) : new Response("not found", { status: 404 });
    }
    if (url.includes("/attachments/")) {
      return json({ data: Buffer.from("a pretend pdf").toString("base64url") });
    }
    if (url.endsWith("/users/me/labels")) {
      return method === "POST" ? json({ id: "label-filed" }) : json({ labels: [] });
    }
    if (url.includes("/modify")) {
      stub.labelled.push(/messages\/([^/?]+)/.exec(url)![1]);
      return json({ id: "ok" });
    }
    if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
      stub.driveUploads += 1;
      const id = `drive-${stub.driveUploads}`;
      return json({ id, webViewLink: `https://drive.google.com/file/d/${id}/view` });
    }
    if (url.startsWith("https://www.googleapis.com/drive/v3/files")) {
      // Creating the folder; reading one back is only asked once remembered.
      return method === "POST" ? json({ id: "folder-1" }) : json({ id: "folder-1" });
    }
    throw new Error(`Unstubbed call to ${method} ${url}`);
  });
}

describe("bills forwarded by email", () => {
  let fixture: Fixture;
  let stub: Stub;

  beforeEach(async () => {
    await resetDatabase();
    fixture = await makeCompanyWithChart("KASAGAMI APARTMENTS");
    stub = { messages: [gmailMessage({ id: "m1" })], calls: [], driveUploads: 0, labelled: [] };
    stubGoogle(stub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A Google connection with whichever scopes the test is about. */
  const connect = async (scopes: string[]) => {
    const sealed = encryptSecret("test-refresh-token");
    return prisma.emailConnection.create({
      data: {
        companyId: fixture.company.id,
        provider: "GOOGLE",
        emailAddress: "docs@bookkeepingpoint.com",
        refreshTokenCiphertext: sealed.ciphertext,
        encryptedDataKey: sealed.encryptedDataKey,
        scope: scopes.join(" "),
      },
    });
  };

  const setAddress = (address: string | null) =>
    prisma.company.update({
      where: { id: fixture.company.id },
      data: { inboxAddress: address },
    });

  const poll = () =>
    pollCompanyInbox({
      companyId: fixture.company.id,
      companyName: fixture.company.name,
      address: ADDRESS,
    });

  describe("which books get polled at all", () => {
    it("knows the send-only grant is not enough", () => {
      expect(hasInboxScopes(GMAIL_SEND_SCOPE)).toBe(false);
      expect(hasInboxScopes(`${GMAIL_SEND_SCOPE} ${GMAIL_INBOX_SCOPE}`)).toBe(false);
      expect(hasInboxScopes(`${GMAIL_INBOX_SCOPE} ${DRIVE_FILE_SCOPE}`)).toBe(true);
      expect(hasInboxScopes(null)).toBe(false);
    });

    it("leaves out a book with no address, and one that may only send", async () => {
      await connect([GMAIL_SEND_SCOPE, GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE]);
      // Address not set yet: nothing is forwarded here, so nothing is read.
      expect(await inboxEnabledCompanies()).toHaveLength(0);

      await setAddress(ADDRESS);
      expect(await inboxEnabledCompanies()).toHaveLength(1);

      // A grant that covers sending only must never be read with.
      await prisma.emailConnection.update({
        where: { companyId: fixture.company.id },
        data: { scope: GMAIL_SEND_SCOPE },
      });
      expect(await inboxEnabledCompanies()).toHaveLength(0);
    });

    it("leaves out a connection Google has stopped accepting", async () => {
      await connect([GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE]);
      await setAddress(ADDRESS);
      await prisma.emailConnection.update({
        where: { companyId: fixture.company.id },
        data: { needsReconnectAt: new Date() },
      });
      expect(await inboxEnabledCompanies()).toHaveLength(0);
    });
  });

  describe("filing what arrived", () => {
    beforeEach(async () => {
      await connect([GMAIL_SEND_SCOPE, GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE]);
      await setAddress(ADDRESS);
    });

    it("files the message, parks the attachment in Drive and posts nothing", async () => {
      const result = await poll();
      expect(result).toMatchObject({ filed: 1, attachments: 1 });

      const [message] = await prisma.inboxMessage.findMany({ include: { attachments: true } });
      expect(message).toMatchObject({
        providerId: "m1",
        subject: "Invoice 4471 from Davao Light",
        fromAddress: "billing@davaolight.test",
        deliveredTo: ADDRESS,
        status: "WAITING",
      });
      expect(message.receivedAt.toISOString()).toBe(new Date(Date.UTC(2026, 9, 14, 9, 30)).toISOString());

      // The file is in Drive and only its link is here.
      expect(message.attachments).toHaveLength(1);
      expect(message.attachments[0].viewUrl).toMatch(/^https:\/\/drive\.google\.com\/file\//);
      expect(message.attachments[0].driveFileId).toBe("drive-1");
      expect(message.attachments[0].uploadError).toBeNull();

      // A forwarded bill is paperwork, not a posting.
      expect(await prisma.journalEntry.count()).toBe(0);
      expect(await prisma.expense.count()).toBe(0);

      // And the mailbox is marked, so a person can see what was taken.
      expect(stub.labelled).toEqual(["m1"]);
    });

    it("files one message once, however often the poll runs", async () => {
      await poll();
      const second = await poll();

      expect(second.filed).toBe(0);
      expect(await prisma.inboxMessage.count()).toBe(1);
      // No second upload either: the duplicate was caught before the work.
      expect(stub.driveUploads).toBe(1);
    });

    it("keeps the bill-shaped attachments and drops the signature furniture", async () => {
      stub.messages = [
        gmailMessage({
          id: "m2",
          attachments: [
            { filename: "bill.pdf", mimeType: "application/pdf", size: 40_000 },
            { filename: "scan.jpg", mimeType: "image/jpeg", size: 300_000 },
            // A logo in the sender's signature, which is an image with a
            // filename too. Filing these turns the folder into noise.
            { filename: "logo.png", mimeType: "image/png", size: 2_400 },
            { filename: "contact.vcf", mimeType: "text/vcard", size: 500 },
          ],
        }),
      ];

      const result = await poll();
      expect(result.attachments).toBe(2);
      const files = await prisma.inboxAttachment.findMany({ orderBy: { filename: "asc" } });
      expect(files.map((file) => file.filename)).toEqual(["bill.pdf", "scan.jpg"]);
    });

    it("still lists a message whose file would not go to Drive, and says why", async () => {
      stub.messages = [
        gmailMessage({
          id: "m3",
          attachments: [
            { filename: "huge.pdf", mimeType: "application/pdf", size: 40 * 1024 * 1024 },
          ],
        }),
      ];

      await poll();
      const [file] = await prisma.inboxAttachment.findMany();
      // Knowing a bill arrived and could not be filed beats not knowing it
      // arrived at all.
      expect(file.viewUrl).toBeNull();
      expect(file.uploadError).toMatch(/too large/i);
      expect(await prisma.inboxMessage.count()).toBe(1);
    });

    it("remembers the Drive folder rather than making one per message", async () => {
      await poll();
      stub.messages = [gmailMessage({ id: "m4" })];
      await poll();

      const company = await prisma.company.findUniqueOrThrow({ where: { id: fixture.company.id } });
      expect(company.inboxDriveFolderId).toBe("folder-1");
      const created = stub.calls.filter(
        (call) => call.method === "POST" && call.url.startsWith("https://www.googleapis.com/drive/v3/files"),
      );
      expect(created).toHaveLength(1);
    });

    it("carries on to the next book when one of them fails", async () => {
      const other = await makeCompanyWithChart("THE PICKLE FARM");
      const sealed = encryptSecret("another-token");
      await prisma.emailConnection.create({
        data: {
          companyId: other.company.id,
          provider: "GOOGLE",
          emailAddress: "docs@bookkeepingpoint.com",
          refreshTokenCiphertext: sealed.ciphertext,
          encryptedDataKey: sealed.encryptedDataKey,
          scope: [GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE].join(" "),
        },
      });
      await prisma.company.update({
        where: { id: other.company.id },
        data: { inboxAddress: "docs+pickle@bookkeepingpoint.com" },
      });

      // The second book's mailbox refuses; the first one's post still lands.
      let seen = 0;
      const realStub = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/users/me/messages?q=") && url.includes("pickle")) {
          seen += 1;
          return new Response("nope", { status: 403 });
        }
        return realStub(input as string, init);
      });

      const results = await runInboxPoll();
      expect(seen).toBe(1);
      expect(results.filter((row) => row.error)).toHaveLength(1);
      expect(results.filter((row) => row.filed === 1)).toHaveLength(1);
      expect(await prisma.inboxMessage.count()).toBe(1);
    });
  });

  describe("what happens to a row", () => {
    beforeEach(async () => {
      await connect([GMAIL_INBOX_SCOPE, DRIVE_FILE_SCOPE]);
      await setAddress(ADDRESS);
      await poll();
    });

    it("can be set aside and put back", async () => {
      const [message] = await prisma.inboxMessage.findMany();
      const owner = await makeUser("OWNER", fixture.company.id);

      await dismissInboxMessage({
        companyId: fixture.company.id,
        messageId: message.id,
        reason: "Statement, not a bill",
        userId: owner.id,
      });
      let after = await prisma.inboxMessage.findUniqueOrThrow({ where: { id: message.id } });
      expect(after.status).toBe("DISMISSED");
      expect(after.dismissedReason).toBe("Statement, not a bill");

      await restoreInboxMessage(fixture.company.id, message.id);
      after = await prisma.inboxMessage.findUniqueOrThrow({ where: { id: message.id } });
      expect(after.status).toBe("WAITING");
      expect(after.dismissedAt).toBeNull();
    });

    it("is crossed off when it becomes an expense, and points at it", async () => {
      const [message] = await prisma.inboxMessage.findMany();
      const { recordExpense } = await import("@/lib/payables/expenses");
      // A bill is owed to somebody; the ledger refuses one without a vendor.
      const vendor = await prisma.vendor.create({
        data: {
          companyId: fixture.company.id,
          kind: "REGULAR",
          name: "DAVAO LIGHT",
          defaultCurrency: "PHP",
        },
      });
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "BILL",
        vendorId: vendor.id,
        date: new Date("2026-10-14"),
        dueDate: new Date("2026-11-14"),
        currency: "PHP",
        amount: "4471.00",
        expenseAccountId: fixture.code("6100").id,
        description: "Invoice 4471 from Davao Light",
        reference: "4471",
      });

      await markInboxRecorded({
        companyId: fixture.company.id,
        messageId: message.id,
        expenseId: expense.id,
      });

      const after = await prisma.inboxMessage.findUniqueOrThrow({ where: { id: message.id } });
      expect(after.status).toBe("RECORDED");
      expect(after.expenseId).toBe(expense.id);
    });

    it("refuses to dismiss one that is already recorded", async () => {
      const [message] = await prisma.inboxMessage.findMany();
      const { recordExpense } = await import("@/lib/payables/expenses");
      const { expense } = await recordExpense({
        companyId: fixture.company.id,
        kind: "DIRECT",
        date: new Date("2026-10-14"),
        currency: "PHP",
        amount: "100.00",
        expenseAccountId: fixture.code("6100").id,
        paymentAccountId: fixture.code("1000").id,
        description: "Already entered",
        reference: "X-1",
      });
      await markInboxRecorded({
        companyId: fixture.company.id,
        messageId: message.id,
        expenseId: expense.id,
      });

      await expect(
        dismissInboxMessage({ companyId: fixture.company.id, messageId: message.id }),
      ).rejects.toThrow(/recorded already/i);
    });

    it("will not touch another company's message", async () => {
      const [message] = await prisma.inboxMessage.findMany();
      const other = await makeCompanyWithChart("THE PICKLE FARM");
      await expect(
        dismissInboxMessage({ companyId: other.company.id, messageId: message.id }),
      ).rejects.toThrow(/not in this company/i);
    });
  });
});
