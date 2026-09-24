import { prisma } from "@/lib/db";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/password";
import { createDefaultChartOfAccounts } from "@/lib/ledger/chart";
import { ALL_SECTIONS } from "@/lib/company-scope";
import { writeAudit } from "@/lib/audit";
import { TERMS_VERSION } from "./terms";

/**
 * Self-serve signup (SPEC §16).
 *
 * Until now every account was created by invitation, which is right for staff
 * and wrong for a stranger buying the software. This builds the whole stack a
 * new subscriber needs in one transaction — user, organization, company,
 * ownership, chart of accounts — because a half-built account is worse than no
 * account: the person cannot use it and cannot sign up again with the same
 * email either.
 *
 * It deliberately does not create the subscription row. Checkout does that,
 * after PayPal has something to say. An organization sitting here with no
 * subscription is simply unmetered, which is the same thing the practice's own
 * organizations are, and a signup abandoned before payment leaves nothing
 * behind that pretends to be paid for.
 */

export type SignupProblem =
  | "name"
  | "email"
  | "password"
  | "confirm"
  | "business"
  | "terms"
  | "taken";

export type SignupResult =
  | { ok: true; userId: string; organizationId: string; companyId: string }
  | { ok: false; problem: SignupProblem };

export const SIGNUP_MESSAGES: Record<SignupProblem, string> = {
  name: "Tell us your name.",
  email: "That does not look like an email address.",
  password: `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
  confirm: "The two passwords do not match.",
  business: "Your business needs a name — you can change it later.",
  terms: "You need to accept the terms of service to create an account.",
  taken: "There is already an account with that email. Sign in instead, or reset your password.",
};

export type SignupInput = {
  name: string;
  email: string;
  password: string;
  confirm: string;
  business: string;
  /** The terms checkbox. False is a refusal, not a validation slip. */
  acceptedTerms: boolean;
  baseCurrency?: string;
  timeZone?: string;
};

export async function createAccount(input: SignupInput): Promise<SignupResult> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const business = input.business.trim();

  if (!name) return { ok: false, problem: "name" };
  // Deliberately loose. An address is proven by mail reaching it, not by a
  // regular expression, and the elaborate ones reject valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, problem: "email" };
  if (input.password.length < PASSWORD_MIN_LENGTH) return { ok: false, problem: "password" };
  if (input.password !== input.confirm) return { ok: false, problem: "confirm" };
  if (!business) return { ok: false, problem: "business" };
  // Checked server-side, not merely marked `required` on the input: a box that
  // only the browser enforces is not a record of anybody agreeing to anything.
  if (!input.acceptedTerms) return { ok: false, problem: "terms" };

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { ok: false, problem: "taken" };

  const passwordHash = await hashPassword(input.password);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          isActive: true,
          // Which wording, not just that a box was ticked. The text changes,
          // and an old consent does not cover a new version.
          termsAcceptedAt: new Date(),
          termsAcceptedVersion: TERMS_VERSION,
        },
      });

      const organization = await tx.organization.create({ data: { name: business } });

      const company = await tx.company.create({
        data: {
          organizationId: organization.id,
          name: business,
          baseCurrency: input.baseCurrency ?? "USD",
          timeClockTimeZone: input.timeZone ?? "Asia/Manila",
          operatingTimeZone: input.timeZone ?? "Asia/Manila",
        },
      });

      await tx.membership.create({
        data: {
          userId: user.id,
          companyId: company.id,
          role: "OWNER",
          // An owner holds every section implicitly, but storing them keeps
          // the row meaningful if the role is ever changed down.
          sections: ALL_SECTIONS,
        },
      });

      await createDefaultChartOfAccounts(company.id, tx);

      return { userId: user.id, organizationId: organization.id, companyId: company.id };
    });

    await writeAudit({
      companyId: created.companyId,
      userId: created.userId,
      action: "account.signed_up",
      entityType: "Company",
      entityId: created.companyId,
      summary: `${business} signed up`,
      data: { termsVersion: TERMS_VERSION },
    });

    return { ok: true, ...created };
  } catch (error) {
    // The unique index on email is the authority, not the check above: two
    // requests can pass that check at the same moment and only one can win.
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return { ok: false, problem: "taken" };
    }
    throw error;
  }
}
