import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "./helpers";

const run = promisify(execFile);

/**
 * `npm run bootstrap` is the only way into a fresh deployment, and the only
 * thing standing between it and a live system is its refusal to run when a user
 * already exists. That refusal is the test.
 *
 * The script runs as a subprocess rather than being imported: it is a CLI whose
 * behaviour depends on stdin being a terminal, and this is how it will actually
 * be invoked.
 */
async function bootstrap(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("npx", ["tsx", "scripts/bootstrap.ts"], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, ...env },
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const OWNER = {
  LEDGER_ADMIN_EMAIL: "first.owner@example.com",
  LEDGER_ADMIN_NAME: "First Owner",
  LEDGER_ORG_NAME: "Real Books",
  LEDGER_COMPANY_NAME: "Real Books",
  LEDGER_ADMIN_PASSWORD: "a-long-enough-password",
};

describe("bootstrap", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("creates one owner with an empty company on a fresh database", async () => {
    const { code, out } = await bootstrap(OWNER);
    expect(out).toContain("Done.");
    expect(code).toBe(0);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "first.owner@example.com" },
      include: { memberships: { include: { company: true } } },
    });
    expect(user.name).toBe("First Owner");
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0].role).toBe("OWNER");

    const company = user.memberships[0].company;
    // Left unfinished on purpose: the permanent base-currency choice belongs to
    // the setup wizard, not to a shell script.
    expect(company.setupCompletedAt).toBeNull();

    // The company is usable the moment it exists: a chart of accounts to post
    // to, and numbering ready to allocate.
    expect(await prisma.account.count({ where: { companyId: company.id } })).toBeGreaterThan(20);
    expect(await prisma.numberSequence.count({ where: { companyId: company.id } })).toBe(4);

    // One owner, and nothing else. No demo data.
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.journalEntry.count()).toBe(0);
  });

  it("refuses to run once any user exists, and writes nothing", async () => {
    await prisma.user.create({
      data: { email: "someone@example.com", name: "Someone", passwordHash: "not-a-real-hash" },
    });

    const { code, out } = await bootstrap(OWNER);
    expect(code).not.toBe(0);
    expect(out).toContain("Refusing to run");

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.user.findUnique({ where: { email: OWNER.LEDGER_ADMIN_EMAIL } })).toBeNull();
    expect(await prisma.organization.count({ where: { name: "Real Books" } })).toBe(0);
  });

  it("rejects a password below the minimum rather than storing a weak one", async () => {
    const { code, out } = await bootstrap({ ...OWNER, LEDGER_ADMIN_PASSWORD: "short" });
    expect(code).not.toBe(0);
    expect(out).toContain("at least 12 characters");
    expect(await prisma.user.count()).toBe(0);
  });

  it("says which variable is missing instead of hanging on a prompt nobody sees", async () => {
    const withoutName = { ...OWNER, LEDGER_ADMIN_NAME: "" };
    const { code, out } = await bootstrap(withoutName);
    expect(code).not.toBe(0);
    expect(out).toContain("LEDGER_ADMIN_NAME");
    expect(await prisma.user.count()).toBe(0);
  });
});
