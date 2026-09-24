import type { Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { PostingError } from "@/lib/errors";

/**
 * What a subscription lets an organization do (SPEC §16).
 *
 * Three rules, and the first is the one that matters most:
 *
 *   1. **No subscription row means unmetered.** Every organization that
 *      existed before self-serve signup looks exactly like that, and reading
 *      absence as "has not paid" would have locked the practice out of its own
 *      books the day billing shipped. Only an organization that went through
 *      checkout is metered, and it is metered because it has a row saying so.
 *
 *   2. **Falling behind never costs anyone their records.** A lapsed
 *      subscription goes read-only: every report, export and past document
 *      stays reachable, and only new postings are refused. These are
 *      accounting records — the year-end they are needed for is often exactly
 *      the moment money is tight.
 *
 *   3. **A failed payment is tolerated for a while.** Cards expire by accident
 *      far more often than people decide to stop paying, and locking someone
 *      out the same hour is a support ticket that should never have existed.
 */

/** How long a failed payment is tolerated before the books go read-only. */
export const GRACE_DAYS = 14;

/** Statuses that permit posting. PENDING does not: nobody has paid yet. */
const MAY_POST: SubscriptionStatus[] = ["ACTIVE", "PAST_DUE"];

export type Standing = {
  /** False only for an organization that went through checkout and lapsed. */
  mayPost: boolean;
  /** Set when there is something the subscriber should see and act on. */
  notice?: string;
  status: SubscriptionStatus | "UNMETERED";
  graceUntil?: Date;
};

const UNMETERED: Standing = { mayPost: true, status: "UNMETERED" };

/** How an organization stands right now. */
export async function standing(
  organizationId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date(),
): Promise<Standing> {
  const subscription = await client.subscription.findUnique({ where: { organizationId } });
  if (!subscription) return UNMETERED;

  // A grace period that has run out is read-only whether or not anything has
  // got round to writing that down. Deciding it here rather than waiting for a
  // job means the answer is right the moment it becomes true, and a scheduler
  // that failed to run cannot silently extend someone's access.
  const graceExpired =
    subscription.status === "PAST_DUE" &&
    subscription.graceUntil !== null &&
    subscription.graceUntil <= now;

  const status: SubscriptionStatus = graceExpired ? "READ_ONLY" : subscription.status;

  if (status === "ACTIVE") return { mayPost: true, status };

  if (status === "PAST_DUE") {
    return {
      mayPost: true,
      status,
      graceUntil: subscription.graceUntil ?? undefined,
      notice: subscription.graceUntil
        ? `A payment did not go through. Your books stay fully usable until ${subscription.graceUntil.toDateString()}, then become read-only until it is settled.`
        : "A payment did not go through. Please update your payment method.",
    };
  }

  if (status === "READ_ONLY") {
    return {
      mayPost: false,
      status,
      notice:
        "Your subscription is unpaid, so the books are read-only. Everything is still here and still exportable — settle the subscription and posting resumes immediately.",
    };
  }

  if (status === "CANCELLED") {
    return {
      mayPost: false,
      status,
      notice:
        "This subscription has been cancelled, so the books are read-only. Your records remain available to read and export.",
    };
  }

  // PENDING.
  return {
    mayPost: false,
    status,
    notice: "Your subscription has not been completed yet. Finish checkout to start posting.",
  };
}

/**
 * Refuse a posting when the subscription does not permit one.
 *
 * Shaped like `assertPeriodOpen` in the ledger, and called from the same place,
 * so there is one answer to "may this post happen" rather than two that can
 * drift. Takes a companyId because that is what a posting knows about itself.
 */
export async function assertSubscriptionPermitsPosting(
  companyId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date(),
): Promise<void> {
  const company = await client.company.findUnique({
    where: { id: companyId },
    select: { organizationId: true },
  });
  if (!company) return;

  const result = await standing(company.organizationId, client, now);
  if (result.mayPost) return;
  throw new PostingError(
    result.notice ?? "This subscription does not currently allow new postings.",
  );
}

/** Statuses that count as a live subscription for display purposes. */
export function isLive(status: SubscriptionStatus): boolean {
  return MAY_POST.includes(status);
}

/**
 * Record that PayPal has confirmed a subscription is paying.
 *
 * Clears the grace clock: a successful payment ends the tolerance for the
 * failure that started it, and leaving a stale `graceUntil` behind would send
 * a paying subscriber read-only on a date nobody remembers setting.
 */
export async function markActive(options: {
  providerSubscriptionId: string;
  payerEmail?: string | null;
  currentPeriodEnd?: Date | null;
  client?: Prisma.TransactionClient | typeof prisma;
}): Promise<void> {
  const client = options.client ?? prisma;
  await client.subscription.updateMany({
    where: { providerSubscriptionId: options.providerSubscriptionId },
    data: {
      status: "ACTIVE",
      graceUntil: null,
      cancelledAt: null,
      ...(options.payerEmail ? { payerEmail: options.payerEmail } : {}),
      ...(options.currentPeriodEnd ? { currentPeriodEnd: options.currentPeriodEnd } : {}),
    },
  });
}

/**
 * Record a failed payment and start the grace clock.
 *
 * Deliberately does not extend an existing one. PayPal retries a failed
 * payment several times and sends a webhook for each; if every one pushed the
 * deadline out, a subscription that never pays again would keep working
 * indefinitely.
 */
export async function markPastDue(options: {
  providerSubscriptionId: string;
  now?: Date;
  client?: Prisma.TransactionClient | typeof prisma;
}): Promise<void> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const existing = await client.subscription.findUnique({
    where: { providerSubscriptionId: options.providerSubscriptionId },
  });
  if (!existing) return;

  const graceUntil =
    existing.graceUntil ?? new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

  await client.subscription.update({
    where: { id: existing.id },
    data: { status: "PAST_DUE", graceUntil },
  });
}

export async function markCancelled(options: {
  providerSubscriptionId: string;
  now?: Date;
  client?: Prisma.TransactionClient | typeof prisma;
}): Promise<void> {
  const client = options.client ?? prisma;
  await client.subscription.updateMany({
    where: { providerSubscriptionId: options.providerSubscriptionId },
    data: { status: "CANCELLED", cancelledAt: options.now ?? new Date() },
  });
}
