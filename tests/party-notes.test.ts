import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCompanyScope } from "@/lib/company-scope";
import {
  MAX_FILES_PER_NOTE,
  createNote,
  deleteNote,
  editNote,
  listNotes,
  noteCounts,
  noteFile,
  whyNotANote,
} from "@/lib/parties/notes";
import { resetStorage, storage } from "@/lib/storage";
import { makeCompanyWithChart, makeCustomer, makeUser, makeVendor, prisma, resetDatabase } from "./helpers";

type Fixture = Awaited<ReturnType<typeof makeCompanyWithChart>>;

const file = (name: string, size = 32) => ({
  filename: name,
  bytes: Buffer.alloc(size, 7),
  mimeType: "application/pdf",
});

/**
 * SPEC §15: notes on a customer, vendor or consultant.
 *
 * The parts worth testing are the ones a note shares with the rest of the app —
 * it cannot reach another company, only its author or an owner may change it —
 * and the one thing unique to it: deleting a note must take its files out of
 * storage, not just its rows out of the database.
 */
describe("party notes", () => {
  let fixture: Fixture;
  let owner: Awaited<ReturnType<typeof makeUser>>;
  let root: string;

  beforeEach(async () => {
    await resetDatabase();
    root = mkdtempSync(path.join(tmpdir(), "ledger-notes-"));
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    resetStorage();
    fixture = await makeCompanyWithChart("Notes Co", "PHP");
    owner = await makeUser("OWNER", fixture.company.id);
  });

  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    await resetDatabase();
    await prisma.$disconnect();
  });

  const scopeFor = (userId: string) => withCompanyScope(userId, fixture.company.id);

  describe("whyNotANote", () => {
    it("wants something written", () => {
      expect(whyNotANote({ body: "   " })).toMatch(/Write something/);
      expect(whyNotANote({ body: "Called about the rate" })).toBeNull();
    });

    it("caps how many files one note carries", () => {
      const many = Array.from({ length: MAX_FILES_PER_NOTE + 1 }, (_, i) => file(`f${i}.pdf`));
      expect(whyNotANote({ body: "ok", files: many })).toMatch(/up to 5 files/);
    });

    it("refuses a file over the limit, and names it", () => {
      const big = file("scan.pdf", 11 * 1024 * 1024);
      expect(whyNotANote({ body: "ok", files: [big] })).toMatch(/scan\.pdf is 11\.0 MB/);
    });
  });

  it("keeps the note with its date, its author and its files", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);

    await createNote(scope, { customerId: customer.id }, {
      body: "Agreed 45 day terms on the phone.",
      files: [file("agreement.pdf"), file("email.pdf")],
    });

    const [note] = await listNotes(scope, { customerId: customer.id });
    expect(note.body).toBe("Agreed 45 day terms on the phone.");
    expect(note.createdByUserId).toBe(owner.id);
    expect(note.createdAt).toBeInstanceOf(Date);
    expect(note.editedAt).toBeNull();
    expect(note.files.map((f) => f.filename)).toEqual(["agreement.pdf", "email.pdf"]);
    expect(note.files[0].sizeBytes).toBe(32);

    // The bytes really went to storage, not just the row to the database.
    expect(await storage().exists(note.files[0].fileKey)).toBe(true);
  });

  it("works the same on a vendor and on a consultant", async () => {
    const scope = await scopeFor(owner.id);
    const vendor = await makeVendor(fixture.company.id, "REGULAR");
    const consultant = await makeVendor(fixture.company.id, "CONSULTANT");

    await createNote(scope, { vendorId: vendor.id }, { body: "Sends invoices late." });
    await createNote(scope, { vendorId: consultant.id }, { body: "Prefers Tuesdays." });

    expect(await listNotes(scope, { vendorId: vendor.id })).toHaveLength(1);
    expect(await listNotes(scope, { vendorId: consultant.id })).toHaveLength(1);
  });

  it("edits the text without moving the date or the author", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);
    const note = await createNote(scope, { customerId: customer.id }, { body: "Fourty five days" });

    const fixed = await editNote(scope, note.id, "Forty-five days");

    expect(fixed.body).toBe("Forty-five days");
    expect(fixed.editedAt).not.toBeNull();
    expect(fixed.createdAt.getTime()).toBe(note.createdAt.getTime());
    expect(fixed.createdByUserId).toBe(owner.id);

    // The trail is append-only, so it is the only thing that still knows.
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "party_note.edited" } });
    expect((audit.data as { was: string }).was).toBe("Fourty five days");
  });

  it("lets the author change it, and a stranger not", async () => {
    const author = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);
    const other = await makeUser("BOOKKEEPER", fixture.company.id, undefined, ["SALES"]);
    const customer = await makeCustomer(fixture.company.id);

    const note = await createNote(await scopeFor(author.id), { customerId: customer.id }, {
      body: "Mine",
    });

    await expect(editNote(await scopeFor(other.id), note.id, "Theirs now")).rejects.toThrow(
      /Only the person who wrote a note, or an owner/,
    );
    // The owner can, because somebody has to be able to.
    await expect(editNote(await scopeFor(owner.id), note.id, "Tidied up")).resolves.toBeTruthy();
  });

  it("takes the files out of storage when the note goes", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);
    const note = await createNote(scope, { customerId: customer.id }, {
      body: "With paperwork",
      files: [file("contract.pdf")],
    });

    const [saved] = await listNotes(scope, { customerId: customer.id });
    const key = saved.files[0].fileKey;
    expect(await storage().exists(key)).toBe(true);

    await deleteNote(scope, note.id);

    expect(await listNotes(scope, { customerId: customer.id })).toHaveLength(0);
    expect(await prisma.partyNoteFile.count()).toBe(0);
    // The bucket must not keep filling with files nothing points at.
    expect(await storage().exists(key)).toBe(false);
  });

  it("goes when the party goes", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);
    await createNote(scope, { customerId: customer.id }, { body: "About them" });

    await prisma.customer.delete({ where: { id: customer.id } });
    expect(await prisma.partyNote.count()).toBe(0);
  });

  it("refuses a party from another company", async () => {
    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
    const theirs = await makeCustomer(elsewhere.company.id);

    await expect(
      createNote(await scopeFor(owner.id), { customerId: theirs.id }, { body: "Reaching" }),
    ).rejects.toThrow(/not found in this company/i);
  });

  it("does not serve another company's attachment", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);
    await createNote(scope, { customerId: customer.id }, {
      body: "Private",
      files: [file("private.pdf")],
    });
    const [note] = await listNotes(scope, { customerId: customer.id });

    const elsewhere = await makeCompanyWithChart("Elsewhere", "PHP");
    const stranger = await makeUser("OWNER", elsewhere.company.id);
    const theirScope = await withCompanyScope(stranger.id, elsewhere.company.id);

    expect(await noteFile(theirScope, note.files[0].id)).toBeNull();
    expect(await noteFile(scope, note.files[0].id)).not.toBeNull();
  });

  it("counts notes per party for the list screens", async () => {
    const scope = await scopeFor(owner.id);
    const a = await makeCustomer(fixture.company.id);
    const b = await makeCustomer(fixture.company.id);
    await createNote(scope, { customerId: a.id }, { body: "One" });
    await createNote(scope, { customerId: a.id }, { body: "Two" });

    const counts = await noteCounts(scope, "customerId", [a.id, b.id]);
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBeUndefined();
  });

  it("newest first, so the last thing said is the first thing read", async () => {
    const scope = await scopeFor(owner.id);
    const customer = await makeCustomer(fixture.company.id);
    await createNote(scope, { customerId: customer.id }, { body: "Older" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await createNote(scope, { customerId: customer.id }, { body: "Newer" });

    const notes = await listNotes(scope, { customerId: customer.id });
    expect(notes.map((note) => note.body)).toEqual(["Newer", "Older"]);
  });
});
