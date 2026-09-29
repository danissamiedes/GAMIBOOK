import { describe, expect, it } from "vitest";
import { buildMimeMessage } from "@/lib/email/mime";

/**
 * How a document email introduces itself (SPEC §10).
 *
 * The sending address is fixed by the connected Gmail account and cannot be
 * changed here. The display name and the reply-to are the parts a company does
 * control, and both are headers — a malformed one is not a cosmetic bug, it is
 * a message the server rejects.
 */

const base = {
  from: "accounting@poisefitnessstudio.com",
  to: ["consultant@example.com"],
  subject: "Work order WO1001",
  text: "Attached.",
};

const headersOf = (message: string) => message.split("\r\n\r\n")[0]!.split("\r\n");
const header = (message: string, name: string) =>
  headersOf(message).find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);

describe("the From line", () => {
  it("is a bare address when there is no display name", () => {
    expect(header(buildMimeMessage(base), "From")).toBe("accounting@poisefitnessstudio.com");
  });

  it("carries the company name when there is one", () => {
    const message = buildMimeMessage({ ...base, fromName: "POISE FITNESS STUDIO" });
    expect(header(message, "From")).toBe(
      '"POISE FITNESS STUDIO" <accounting@poisefitnessstudio.com>',
    );
  });

  it("quotes a name containing a comma, so it cannot read as two addresses", () => {
    const message = buildMimeMessage({ ...base, fromName: "Poise Fitness Studio, Inc." });
    expect(header(message, "From")).toBe(
      '"Poise Fitness Studio, Inc." <accounting@poisefitnessstudio.com>',
    );
  });

  it("escapes a quote inside the name rather than emitting a broken header", () => {
    const message = buildMimeMessage({ ...base, fromName: 'The "Studio"' });
    expect(header(message, "From")).toBe(
      '"The \\"Studio\\"" <accounting@poisefitnessstudio.com>',
    );
  });

  it("encodes a non-ASCII name instead of mangling it", () => {
    const message = buildMimeMessage({ ...base, fromName: "Café Books" });
    const from = header(message, "From")!;
    expect(from).toMatch(/^=\?UTF-8\?B\?/);
    expect(from).toContain("<accounting@poisefitnessstudio.com>");
  });

  it("treats a blank or whitespace-only name as no name at all", () => {
    for (const fromName of ["", "   ", null, undefined]) {
      expect(header(buildMimeMessage({ ...base, fromName }), "From")).toBe(
        "accounting@poisefitnessstudio.com",
      );
    }
  });
});

describe("the Reply-To line", () => {
  it("is absent unless one is set", () => {
    expect(header(buildMimeMessage(base), "Reply-To")).toBeUndefined();
  });

  it("is written when replies should go elsewhere", () => {
    const message = buildMimeMessage({ ...base, replyTo: "accounts@poisefitnessstudio.com" });
    expect(header(message, "Reply-To")).toBe("accounts@poisefitnessstudio.com");
  });

  it("is omitted when it only repeats the sender", () => {
    // Some clients show a redundant Reply-To to the reader as a second line.
    const message = buildMimeMessage({ ...base, replyTo: base.from });
    expect(header(message, "Reply-To")).toBeUndefined();
  });
});

describe("the rest of the message is unchanged", () => {
  it("still carries To, Subject and the body", () => {
    const message = buildMimeMessage({
      ...base,
      fromName: "POISE FITNESS STUDIO",
      replyTo: "accounts@poisefitnessstudio.com",
      cc: ["manager@example.com"],
    });
    expect(header(message, "To")).toBe("consultant@example.com");
    expect(header(message, "Cc")).toBe("manager@example.com");
    expect(header(message, "Subject")).toBe("Work order WO1001");
    expect(message).toContain(Buffer.from("Attached.", "utf8").toString("base64"));
  });
});
