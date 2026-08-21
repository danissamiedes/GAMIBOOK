import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  inviteExpiry,
  resetExpiry,
  INVITE_TTL_DAYS,
} from "@/lib/tokens";

describe("invite and reset tokens", () => {
  it("generates unpredictable tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it("stores only a hash, and the hash is stable", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expires invitations in 7 days, per SPEC §2", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(inviteExpiry(from).toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("expires reset links quickly", () => {
    const from = new Date("2026-01-01T00:00:00Z");
    expect(resetExpiry(from).getTime() - from.getTime()).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
  });
});
