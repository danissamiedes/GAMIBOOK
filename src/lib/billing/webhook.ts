import { prisma } from "@/lib/db";
import { markActive, markCancelled, markPastDue } from "./subscription";

/**
 * What to do with each PayPal billing event (SPEC §16).
 *
 * Split from the route so the decisions can be tested without an HTTP request,
 * and so the route is left doing only what a route should: verify, hand over,
 * answer.
 *
 * Every event is written down before it is acted on, keyed by PayPal's own
 * event id. PayPal retries anything it did not get a 200 for, and replays are
 * ordinary traffic rather than an attack — but a "payment failed" applied twice
 * would restart a grace period, and a replayed "cancelled" arriving after a
 * fresh signup would cancel the new one. The insert is what stops both.
 */

export type HandledEvent = {
  /** What was done, in words a log reader can act on. */
  outcome: "applied" | "duplicate" | "ignored" | "unknown-subscription";
  eventType: string;
};

/** The events worth acting on. Everything else is noise for our purposes. */
const HANDLED = new Set([
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "PAYMENT.SALE.COMPLETED",
]);

type Envelope = {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    /** On a PAYMENT.SALE.* event the subscription is here instead. */
    billing_agreement_id?: string;
    status?: string;
    custom_id?: string;
    subscriber?: { email_address?: string };
    billing_info?: { next_billing_time?: string };
  };
};

/** The subscription an event is about, whichever shape it arrived in. */
function subscriptionIdOf(event: Envelope): string | undefined {
  return event.resource?.billing_agreement_id ?? event.resource?.id;
}

function nextBilling(event: Envelope): Date | null {
  const raw = event.resource?.billing_info?.next_billing_time;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function handleWebhookEvent(
  event: Envelope,
  now: Date = new Date(),
): Promise<HandledEvent> {
  const eventType = event.event_type ?? "unknown";
  if (!event.id) return { outcome: "ignored", eventType };
  if (!HANDLED.has(eventType)) return { outcome: "ignored", eventType };

  // Claim the event first. A unique violation here means a retry of one
  // already applied, and the right answer to that is 200 and nothing else.
  try {
    await prisma.providerWebhookEvent.create({
      data: {
        id: event.id,
        provider: "paypal",
        eventType,
        payload: event as object,
      },
    });
  } catch {
    return { outcome: "duplicate", eventType };
  }

  const providerSubscriptionId = subscriptionIdOf(event);
  if (!providerSubscriptionId) return { outcome: "ignored", eventType };

  const known = await prisma.subscription.findUnique({
    where: { providerSubscriptionId },
    select: { id: true },
  });
  if (!known) return { outcome: "unknown-subscription", eventType };

  switch (eventType) {
    case "BILLING.SUBSCRIPTION.ACTIVATED":
    case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
    case "PAYMENT.SALE.COMPLETED":
      await markActive({
        providerSubscriptionId,
        payerEmail: event.resource?.subscriber?.email_address ?? null,
        currentPeriodEnd: nextBilling(event),
      });
      break;

    // A suspension is PayPal giving up on collecting, and a failed payment is
    // it about to. Both start the same clock rather than cutting access off,
    // because both are usually an expired card.
    case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
    case "BILLING.SUBSCRIPTION.SUSPENDED":
      await markPastDue({ providerSubscriptionId, now });
      break;

    case "BILLING.SUBSCRIPTION.CANCELLED":
    case "BILLING.SUBSCRIPTION.EXPIRED":
      await markCancelled({ providerSubscriptionId, now });
      break;

    // An UPDATED event carries a status but no instruction. Trust the status.
    case "BILLING.SUBSCRIPTION.UPDATED": {
      const status = event.resource?.status;
      if (status === "ACTIVE") {
        await markActive({
          providerSubscriptionId,
          currentPeriodEnd: nextBilling(event),
        });
      } else if (status === "SUSPENDED") {
        await markPastDue({ providerSubscriptionId, now });
      } else if (status === "CANCELLED" || status === "EXPIRED") {
        await markCancelled({ providerSubscriptionId, now });
      }
      break;
    }
  }

  return { outcome: "applied", eventType };
}
