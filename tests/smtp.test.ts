import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { connectSmtp, validateSmtp } from "@/lib/email/smtp";
import { connectedMailbox } from "@/lib/email/gmail";
import { decryptSecret } from "@/lib/email/crypto";
import { makeCompanyWithChart, prisma, resetDatabase } from "./helpers";

beforeAll(() => {
  // Sealing a password needs the envelope key, exactly as the Google token does.
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

beforeEach(async () => {
  await resetDatabase();
});

const good = {
  host: "smtp.titan.email",
  port: 465,
  secure: true,
  username: "accounting@poisefitnessstudio.com",
  password: "a-mailbox-password",
  fromAddress: "accounting@poisefitnessstudio.com",
};

describe("SMTP settings are checked before they are stored (SPEC §10)", () => {
  it("accepts a complete, secure configuration", () => {
    expect(validateSmtp(good)).toBeNull();
  });

  it("refuses port 25, which sends the password in the clear", () => {
    // Not a warning. A mailbox password crossing the internet unencrypted is
    // the kind of default nobody revisits.
    const problem = validateSmtp({ ...good, port: 25 });
    expect(problem?.field).toBe("port");
    expect(problem?.message).toMatch(/in the clear/i);
  });

  it("names the missing field rather than failing generically", () => {
    expect(validateSmtp({ ...good, host: "  " })?.field).toBe("host");
    expect(validateSmtp({ ...good, username: "" })?.field).toBe("username");
    expect(validateSmtp({ ...good, password: "" })?.field).toBe("password");
    expect(validateSmtp({ ...good, fromAddress: "not-an-email" })?.field).toBe("fromAddress");
    expect(validateSmtp({ ...good, port: 99999 })?.field).toBe("port");
  });
});

describe("storing an SMTP connection (SPEC §10)", () => {
  it("seals the password rather than keeping it readable", async () => {
    const fixture = await makeCompanyWithChart("Titan Co");
    await connectSmtp({ companyId: fixture.company.id, settings: good });

    const row = await prisma.emailConnection.findUniqueOrThrow({
      where: { companyId: fixture.company.id },
    });
    expect(row.provider).toBe("SMTP");
    expect(row.smtpHost).toBe("smtp.titan.email");
    expect(row.smtpPort).toBe(465);

    // The password is nowhere in the row as typed.
    expect(JSON.stringify(row)).not.toContain(good.password);
    // But it round-trips for the sender.
    expect(
      decryptSecret({
        ciphertext: row.smtpPasswordCiphertext!,
        encryptedDataKey: row.smtpPasswordKey!,
      }),
    ).toBe(good.password);
  });

  it("clears any Google credentials it replaces", async () => {
    // A company that moves from Gmail to Titan must not leave a live refresh
    // token beside its new settings.
    const fixture = await makeCompanyWithChart("Switcher Co");
    await prisma.emailConnection.create({
      data: {
        companyId: fixture.company.id,
        provider: "GOOGLE",
        emailAddress: "someone@gmail.com",
        refreshTokenCiphertext: "old-cipher",
        encryptedDataKey: "old-key",
        scope: "https://www.googleapis.com/auth/gmail.send",
      },
    });

    await connectSmtp({ companyId: fixture.company.id, settings: good });

    const row = await prisma.emailConnection.findUniqueOrThrow({
      where: { companyId: fixture.company.id },
    });
    expect(row.provider).toBe("SMTP");
    expect(row.refreshTokenCiphertext).toBeNull();
    expect(row.encryptedDataKey).toBeNull();
    expect(row.emailAddress).toBe("accounting@poisefitnessstudio.com");
  });

  it("lowercases the sending address, so it matches however it was typed", async () => {
    const fixture = await makeCompanyWithChart("Case Co");
    await connectSmtp({
      companyId: fixture.company.id,
      settings: { ...good, fromAddress: "  Accounting@PoiseFitnessStudio.com " },
    });
    const mailbox = await connectedMailbox(fixture.company.id);
    expect(mailbox?.emailAddress).toBe("accounting@poisefitnessstudio.com");
  });

  it("replaces an earlier SMTP connection rather than adding a second", async () => {
    const fixture = await makeCompanyWithChart("Replace Co");
    await connectSmtp({ companyId: fixture.company.id, settings: good });
    await connectSmtp({
      companyId: fixture.company.id,
      settings: { ...good, host: "smtp.office365.com", port: 587, secure: false },
    });

    expect(await prisma.emailConnection.count()).toBe(1);
    const row = await prisma.emailConnection.findUniqueOrThrow({
      where: { companyId: fixture.company.id },
    });
    expect(row.smtpHost).toBe("smtp.office365.com");
    expect(row.smtpSecure).toBe(false);
  });
});

describe("what a failure tells the person reading it (SPEC §10)", () => {
  // The first real attempt at this failed on a hostname typo and reported
  // "getaddrinfo EBUSY smtp.tital.email" — the answer buried in jargon.
  it("reads a DNS failure as a hostname problem, whichever code it arrives as", async () => {
    const { verifySmtp } = await import("@/lib/email/smtp");

    const result = await verifySmtp({
      ...good,
      // A name that cannot resolve, in a reserved TLD that never will.
      host: "smtp.tital.invalid",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be reached/i);
    expect(result.reason).toMatch(/typo/i);
    // It names the host it tried, so a typo is visible in the message itself.
    expect(result.reason).toContain("smtp.tital.invalid");
    // And never leaks the raw resolver code at the reader.
    expect(result.reason).not.toMatch(/getaddrinfo|EBUSY|ENOTFOUND/);
  }, 30_000);
});
