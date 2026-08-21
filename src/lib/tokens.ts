import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invite and password-reset tokens. The raw token exists only in the link we
 * hand out; the database stores its SHA-256, so a database leak does not hand
 * anyone a working invite (SPEC §2, §13).
 */

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export const INVITE_TTL_DAYS = 7;
export const RESET_TTL_HOURS = 2;

export function inviteExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function resetExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + RESET_TTL_HOURS * 60 * 60 * 1000);
}
