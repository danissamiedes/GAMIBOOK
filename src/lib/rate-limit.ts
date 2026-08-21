import { prisma } from "@/lib/db";

/**
 * Fixed-window rate limiter for login and password-reset attempts (SPEC §13).
 *
 * The window lives in Postgres, not in process memory. On a single VPS either
 * would do; on a serverless host a per-process counter is barely a limit at all,
 * because every cold start hands the caller a fresh allowance. Same table, same
 * answer, however many instances are running.
 *
 * The whole check is one statement so that concurrent attempts cannot both read
 * the same count and both decide they are under it.
 */

export type RateLimitResult = { ok: boolean; retryAfterSeconds: number };

type Row = { count: number; resetAt: Date };

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const rows = await prisma.$queryRaw<Row[]>`
    INSERT INTO "RateLimit" ("key", "count", "resetAt")
    VALUES (${key}, 1, now() + make_interval(secs => ${windowSeconds}::double precision))
    ON CONFLICT ("key") DO UPDATE SET
      -- An expired window is a new window, not a continuation of the old one.
      "count"   = CASE WHEN "RateLimit"."resetAt" <= now() THEN 1
                       ELSE "RateLimit"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimit"."resetAt" <= now()
                       THEN now() + make_interval(secs => ${windowSeconds}::double precision)
                       ELSE "RateLimit"."resetAt" END
    RETURNING "count", "resetAt"
  `;

  const row = rows[0];
  if (!row) return { ok: true, retryAfterSeconds: 0 };

  if (row.count > limit) {
    const seconds = Math.ceil((row.resetAt.getTime() - Date.now()) / 1000);
    return { ok: false, retryAfterSeconds: Math.max(seconds, 1) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

/** Clear a key's window — called after a successful sign-in. */
export async function resetRateLimit(key: string): Promise<void> {
  await prisma.rateLimit.deleteMany({ where: { key } });
}

/**
 * Drop windows that have already expired. Nothing depends on this running —
 * an expired row is ignored either way — it just keeps the table from growing
 * one row per email anyone ever tried.
 */
export async function pruneRateLimits(): Promise<{ deleted: number }> {
  const { count } = await prisma.rateLimit.deleteMany({ where: { resetAt: { lte: new Date() } } });
  return { deleted: count };
}

/** Test seam only. */
export async function clearAllRateLimits(): Promise<void> {
  await prisma.rateLimit.deleteMany({});
}
