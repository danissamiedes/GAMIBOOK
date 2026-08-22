import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Route-level guard (SPEC §2). Two jobs:
 *
 *   1. Signed-out users get sent to /login.
 *   2. A user whose only memberships are CONSULTANT cannot reach an accounting
 *      route — they land on the time clock and stay there.
 *
 * This is the outer gate only. Roles are per company, so the authoritative
 * check is withCompanyScope()/withFinancialScope() at the data-access layer,
 * which runs on every query regardless of what this decides.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/invite",
  "/api/auth",
  // Scheduled jobs arrive with no session, by definition. The route checks
  // CRON_SECRET itself; letting it through here is not letting it through.
  "/api/cron",
  // Same reasoning: a health check has to answer precisely when signing in
  // does not. It checks CRON_SECRET itself.
  "/api/health",
  "/_next",
  "/favicon.ico",
];

/** The only routes a CONSULTANT may reach. */
const CONSULTANT_PREFIXES = ["/time-clock", "/account", "/api/auth", "/logout"];

function matches(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Auth.js v5 encrypts the session JWT and derives its key from the cookie name,
 * so the salt must match the cookie the app actually set. Which cookie that is
 * depends on whether the response went out over https — not on NODE_ENV, which
 * is "production" for `next start` on plain http too. Read whichever is
 * present rather than guessing.
 */
const SESSION_COOKIES = ["__Secure-authjs.session-token", "authjs.session-token"] as const;

async function readSessionToken(req: NextRequest) {
  for (const cookieName of SESSION_COOKIES) {
    if (!req.cookies.has(cookieName)) continue;
    const token = await getToken({
      req,
      secret: process.env.AUTH_SECRET,
      secureCookie: cookieName.startsWith("__Secure-"),
      salt: cookieName,
      cookieName,
    });
    if (token) return token;
  }
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (matches(pathname, PUBLIC_PREFIXES)) return NextResponse.next();

  const token = await readSessionToken(req);

  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  if (token.consultantOnly === true && !matches(pathname, CONSULTANT_PREFIXES)) {
    const url = req.nextUrl.clone();
    url.pathname = "/time-clock";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
