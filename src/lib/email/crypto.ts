import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for stored OAuth refresh tokens (SPEC §10, §13).
 *
 * A fresh 256-bit data key encrypts the token; the data key is itself
 * encrypted with the key from the environment. Two consequences worth the
 * extra step: the environment key never touches the ciphertext of a secret
 * directly, and rotating it means re-wrapping short data keys rather than
 * re-encrypting every record.
 *
 * A database dump on its own decrypts nothing.
 */

const ALGORITHM = "aes-256-gcm";

function environmentKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  }
  return key;
}

/** iv:tag:ciphertext, each base64, so one string round-trips a whole payload. */
function seal(plaintext: Buffer, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

function open(sealed: string, key: Buffer): Buffer {
  const [ivPart, tagPart, dataPart] = sealed.split(":");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]);
}

export type SealedSecret = { ciphertext: string; encryptedDataKey: string };

export function encryptSecret(plaintext: string): SealedSecret {
  const dataKey = randomBytes(32);
  return {
    ciphertext: seal(Buffer.from(plaintext, "utf8"), dataKey),
    encryptedDataKey: seal(dataKey, environmentKey()),
  };
}

export function decryptSecret(sealed: SealedSecret): string {
  const dataKey = open(sealed.encryptedDataKey, environmentKey());
  return open(sealed.ciphertext, dataKey).toString("utf8");
}

/** True when the environment is configured to store tokens at all. */
export function encryptionAvailable(): boolean {
  try {
    environmentKey();
    return true;
  } catch {
    return false;
  }
}
