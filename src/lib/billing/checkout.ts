import { prisma } from "@/lib/db";
import { createSubscription, getSubscription, systemPlanId } from "./paypal";
import { markActive } from "./subscription";

/**
 * Starting and finishing a checkout (SPEC §16).
 *
 * Two halves with PayPal's approval page between them. `beginCheckout` creates
 * the subscription and hands back where to send the payer; `completeCheckout`
 * runs when they come back, and asks PayPal what actually happened rather than
 * believing the redirect.
 *
 * That second point is the one worth being careful about. The return URL is
 * just a URL — a person can type it, bookmark it, or share it — so treating
 * arrival there as proof of payment would hand out free subscriptions to
 * anyone who noticed. The only thing that grants access is PayPal saying the
 * subscription is active, and the webhook says the same thing independently.
 */

export type BeginResult =
  | { ok: true; approveUrl: string }
  | { ok: false; reason: "not-configured" | "already-subscribed" };

export async function beginCheckout(options: {
  organizationId: string;
  email: string;
  name?: string;
  origin: string;
}): Promise<BeginResult> {
  const planId = systemPlanId();
  if (!planId) return { ok: false, reason: "not-configured" };

  const existing = await prisma.subscription.findUnique({
    where: { organizationId: options.organizationId },
  });
  if (existing && (existing.status === "ACTIVE" || existing.status === "PAST_DUE")) {
    return { ok: false, reason: "already-subscribed" };
  }

  const created = await createSubscription({
    planId,
    // Our own id, carried through PayPal and returned in every webhook about
    // this subscription. The payer's email is not a key: people pay from a
    // different PayPal account than the one they signed up with routinely.
    customId: options.organizationId,
    subscriberEmail: options.email,
    subscriberName: options.name,
    returnUrl: `${options.origin}/subscribe/return`,
    cancelUrl: `${options.origin}/subscribe?cancelled=1`,
  });

  // Written before the payer is sent anywhere, so the webhook has something to
  // find. PayPal can deliver ACTIVATED before the browser finishes redirecting
  // back, and an event about a subscription we have no row for is an event
  // that gets dropped.
  await prisma.subscription.upsert({
    where: { organizationId: options.organizationId },
    create: {
      organizationId: options.organizationId,
      plan: "GAMIBOOK_SYSTEM",
      status: "PENDING",
      providerSubscriptionId: created.id,
      providerPlanId: planId,
      payerEmail: options.email,
    },
    update: {
      status: "PENDING",
      providerSubscriptionId: created.id,
      providerPlanId: planId,
      payerEmail: options.email,
      cancelledAt: null,
      graceUntil: null,
    },
  });

  return { ok: true, approveUrl: created.approveUrl };
}

export type CompleteResult =
  | { ok: true; status: "ACTIVE" }
  | { ok: false; reason: "unknown" | "not-active"; remoteStatus?: string };

/**
 * Confirm a subscription after the payer returns from PayPal.
 *
 * Asks PayPal directly. A subscription PayPal calls APPROVAL_PENDING or
 * APPROVED but not ACTIVE is not yet paying, and is left alone for the webhook
 * to resolve — PayPal moves it on its own schedule, and guessing here would
 * mean granting access that has not been paid for.
 */
export async function completeCheckout(options: {
  organizationId: string;
  providerSubscriptionId: string;
}): Promise<CompleteResult> {
  const local = await prisma.subscription.findUnique({
    where: { organizationId: options.organizationId },
  });
  // The id must belong to this organization. Without this check, anyone could
  // append someone else's subscription id to the return URL.
  if (!local || local.providerSubscriptionId !== options.providerSubscriptionId) {
    return { ok: false, reason: "unknown" };
  }

  const remote = await getSubscription(options.providerSubscriptionId);
  if (remote.status !== "ACTIVE") {
    return { ok: false, reason: "not-active", remoteStatus: remote.status };
  }

  const nextBilling = remote.billing_info?.next_billing_time;
  await markActive({
    providerSubscriptionId: options.providerSubscriptionId,
    payerEmail: remote.subscriber?.email_address ?? null,
    currentPeriodEnd: nextBilling ? new Date(nextBilling) : null,
  });

  return { ok: true, status: "ACTIVE" };
}
