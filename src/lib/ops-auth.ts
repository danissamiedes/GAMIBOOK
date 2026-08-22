import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The guard on the operational endpoints — /api/cron and /api/health. They are
 * reachable without a session by necessity: a scheduler has none, and a health
 * check has to work precisely when signing in does not.
 *
 * CRON_SECRET is the only thing between them and a stranger, so it fails closed
 * when unset and never reads the secret from the query string: URLs end up in
 * access logs, browser history and referrer headers.
 */
export function opsAuthorised(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Vercel Cron sends Authorization itself; x-cron-key is for external pingers
  // that only offer a custom header.
  const offered =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-cron-key") ??
    "";
  if (!offered) return false;

  // Digest both sides so the comparison is constant-time whatever the lengths.
  return timingSafeEqual(
    createHash("sha256").update(offered).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
