import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";

declare module "next-auth" {
  interface Session {
    user: { id: string; consultantOnly: boolean } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    consultantOnly?: boolean;
  }
}

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * App login (SPEC §13). Separate concern from the Gmail *sending* connection in
 * SPEC §10 — connecting a mailbox to send from is not signing in.
 *
 * Sessions are JWTs in HTTP-only cookies, which Auth.js sets by default.
 */
const providers: NextAuthConfig["providers"] = [
  Credentials({
    credentials: { email: {}, password: {} },
    authorize: async (raw) => {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const email = parsed.data.email.toLowerCase().trim();

      // Rate-limit login attempts (SPEC §13): 10 per email per 15 minutes.
      // Counted before the user lookup, so being throttled says nothing about
      // whether the address exists — which is what makes it safe to report.
      const limit = await rateLimit(`login:${email}`, 10, 15 * 60);
      if (!limit.ok) throw new RateLimitError(limit.retryAfterSeconds);

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user?.passwordHash || !user.isActive) return null;

      const ok = await verifyPassword(user.passwordHash, parsed.data.password);
      if (!ok) return null;

      await resetRateLimit(`login:${email}`);
      await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

      return { id: user.id, email: user.email, name: user.name };
    },
  }),
];

if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: false,
    }),
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login", error: "/login" },
  trustHost: true,
  callbacks: {
    /**
     * Google sign-in only works for a user who already exists — there is no
     * self-service signup in this system. You get in by invitation (SPEC §2).
     */
    signIn: async ({ user, account }) => {
      if (account?.provider !== "google") return true;
      const email = user.email?.toLowerCase();
      if (!email) return false;
      const existing = await prisma.user.findUnique({ where: { email } });
      return Boolean(existing?.isActive);
    },
    /**
     * `consultantOnly` rides in the token so middleware can keep consultants
     * out of accounting routes without a database round trip on every request
     * (SPEC §2). It is a coarse gate, not the real guard: per-company role
     * checks still happen in the layout and, decisively, in the data-access
     * layer via withFinancialScope().
     */
    jwt: async ({ token, user, trigger }) => {
      if (user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase() },
          select: { id: true },
        });
        if (dbUser) token.sub = dbUser.id;
      }
      if (token.sub && (user || trigger === "update" || token.consultantOnly === undefined)) {
        const roles = await prisma.membership.findMany({
          where: { userId: token.sub },
          select: { role: true },
        });
        token.consultantOnly = roles.length > 0 && roles.every((r) => r.role === "CONSULTANT");
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (token.sub) session.user.id = token.sub;
      session.user.consultantOnly = token.consultantOnly === true;
      return session;
    },
  },
});

/** The signed-in user's id, or null. Never trusted for company access on its own. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}
