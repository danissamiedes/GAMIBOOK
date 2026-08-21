import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, encryptionAvailable } from "@/lib/email/crypto";

describe("refresh token encryption (SPEC §10)", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("round-trips a secret", () => {
    const token = "1//0gRefreshTokenFromGoogle-xyz";
    const sealed = encryptSecret(token);
    expect(decryptSecret(sealed)).toBe(token);
  });

  it("never stores the secret in the clear", () => {
    const sealed = encryptSecret("super-secret-token");
    expect(sealed.ciphertext).not.toContain("super-secret");
    expect(sealed.encryptedDataKey).not.toContain("super-secret");
  });

  it("uses a fresh data key each time, so identical secrets differ on disk", () => {
    const first = encryptSecret("same-token");
    const second = encryptSecret("same-token");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.encryptedDataKey).not.toBe(second.encryptedDataKey);
  });

  it("refuses tampered ciphertext rather than returning garbage", () => {
    const sealed = encryptSecret("token");
    const [iv, tag, data] = sealed.ciphertext.split(":");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() =>
      decryptSecret({
        ciphertext: [iv, tag, flipped.toString("base64")].join(":"),
        encryptedDataKey: sealed.encryptedDataKey,
      }),
    ).toThrow();
  });

  it("will not decrypt with a different environment key", () => {
    const sealed = encryptSecret("token");
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(sealed)).toThrow();
    process.env.TOKEN_ENCRYPTION_KEY = original;
  });

  it("reports when the environment has no key configured", () => {
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(encryptionAvailable()).toBe(false);
    expect(() => encryptSecret("token")).toThrow(/TOKEN_ENCRYPTION_KEY/);
    process.env.TOKEN_ENCRYPTION_KEY = original;
  });

  it("rejects a key of the wrong length", () => {
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from("too short").toString("base64");
    expect(() => encryptSecret("token")).toThrow(/32 bytes/);
    process.env.TOKEN_ENCRYPTION_KEY = original;
  });
});
