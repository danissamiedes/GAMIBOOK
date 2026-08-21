import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, PASSWORD_MIN_LENGTH } from "@/lib/password";

describe("password hashing", () => {
  it("round-trips a password with argon2id", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(verifyPassword(hash, "correct horse battery staple")).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password entirely")).resolves.toBe(false);
  });

  it("salts, so the same password hashes differently each time", async () => {
    const a = await hashPassword("the same password twice");
    const b = await hashPassword("the same password twice");
    expect(a).not.toBe(b);
  });

  it("rejects a password below the minimum length", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least/);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
  });

  it("states a minimum worth having", () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
  });
});
