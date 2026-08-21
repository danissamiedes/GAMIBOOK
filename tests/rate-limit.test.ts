import { beforeEach, describe, expect, it } from "vitest";
import { clearAllRateLimits, pruneRateLimits, rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { prisma } from "./helpers";

describe("rate limiting", () => {
  beforeEach(async () => {
    await clearAllRateLimits();
  });

  it("allows up to the limit and then refuses", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await rateLimit("key", 5, 60)).ok).toBe(true);
    }
    const blocked = await rateLimit("key", 5, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each key separately", async () => {
    await rateLimit("a@example.test", 1, 60);
    expect((await rateLimit("a@example.test", 1, 60)).ok).toBe(false);
    expect((await rateLimit("b@example.test", 1, 60)).ok).toBe(true);
  });

  it("clears a key on demand, which is what a successful sign-in does", async () => {
    await rateLimit("key", 1, 60);
    expect((await rateLimit("key", 1, 60)).ok).toBe(false);
    await resetRateLimit("key");
    expect((await rateLimit("key", 1, 60)).ok).toBe(true);
  });

  it("starts a fresh window once the old one has expired", async () => {
    await rateLimit("key", 1, 60);
    expect((await rateLimit("key", 1, 60)).ok).toBe(false);

    // Reach in and expire the window rather than waiting a minute for it.
    await prisma.rateLimit.update({
      where: { key: "key" },
      data: { resetAt: new Date(Date.now() - 1000) },
    });

    expect((await rateLimit("key", 1, 60)).ok).toBe(true);
    // ...and the new window counts from one, not from where the old one left off.
    expect((await rateLimit("key", 1, 60)).ok).toBe(false);
  });

  /**
   * The reason the whole check is a single statement. Ten simultaneous attempts
   * against a limit of five must let exactly five through — a read-then-write
   * implementation lets all ten read "0 so far" and proceed.
   */
  it("holds the limit when attempts arrive at the same moment", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rateLimit("burst", 5, 60)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
  });

  /**
   * The point of moving this out of memory: the window is a row, so a new
   * instance with an empty heap still sees the attempts the last one counted.
   */
  it("keeps the window in the database, not in the process", async () => {
    for (let i = 0; i < 5; i += 1) await rateLimit("login:someone@example.test", 5, 60);

    const row = await prisma.rateLimit.findUniqueOrThrow({
      where: { key: "login:someone@example.test" },
    });
    expect(row.count).toBe(5);
    expect(row.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("prunes only windows that have already expired", async () => {
    await rateLimit("live", 5, 60);
    await rateLimit("dead", 5, 60);
    await prisma.rateLimit.update({
      where: { key: "dead" },
      data: { resetAt: new Date(Date.now() - 1000) },
    });

    expect(await pruneRateLimits()).toEqual({ deleted: 1 });
    expect(await prisma.rateLimit.findUnique({ where: { key: "live" } })).not.toBeNull();
    expect(await prisma.rateLimit.findUnique({ where: { key: "dead" } })).toBeNull();
  });
});
