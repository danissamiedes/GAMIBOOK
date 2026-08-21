import { beforeEach, describe, expect, it } from "vitest";
import { clearAllRateLimits, rateLimit, resetRateLimit } from "@/lib/rate-limit";

describe("login rate limiting", () => {
  beforeEach(() => clearAllRateLimits());

  it("allows up to the limit and then blocks", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(rateLimit("key", 5, 60).ok).toBe(true);
    }
    const blocked = rateLimit("key", 5, 60);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts each key separately", () => {
    rateLimit("a@example.test", 1, 60);
    expect(rateLimit("a@example.test", 1, 60).ok).toBe(false);
    expect(rateLimit("b@example.test", 1, 60).ok).toBe(true);
  });

  it("clears the counter on a successful sign-in", () => {
    rateLimit("key", 1, 60);
    expect(rateLimit("key", 1, 60).ok).toBe(false);
    resetRateLimit("key");
    expect(rateLimit("key", 1, 60).ok).toBe(true);
  });
});
