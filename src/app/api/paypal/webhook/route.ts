import { NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/billing/paypal";
import { handleWebhookEvent } from "@/lib/billing/webhook";

/**
 * Where PayPal tells us what happened (SPEC §16).
 *
 * Register this as `https://<your domain>/api/paypal/webhook` in the PayPal
 * developer dashboard, and put the webhook id it gives back into
 * PAYPAL_WEBHOOK_ID. Without that id nothing here is verifiable, and an
 * unverifiable webhook is refused rather than trusted — this endpoint grants
 * paid access, so "cannot check" has to mean no.
 *
 * The body is read as raw text and passed to verification untouched. Parsing
 * and re-serializing reorders keys, and PayPal's signature is over the bytes
 * it sent.
 */

export const runtime = "nodejs";
/** Verification is a round trip to PayPal, so give it room. */
export const maxDuration = 30;

export async function POST(request: Request) {
  const body = await request.text();

  const verified = await verifyWebhook({ headers: request.headers, body });
  if (!verified) {
    // 401, not 400: PayPal retries a 5xx and gives up on a 4xx, and an
    // unverified delivery is not something a retry will fix.
    return NextResponse.json({ error: "Signature not verified" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }

  try {
    const result = await handleWebhookEvent(event as Parameters<typeof handleWebhookEvent>[0]);
    return NextResponse.json(result);
  } catch (error) {
    // A 500 asks PayPal to retry, which is what we want when the failure is
    // ours: the event is real and has not been applied.
    console.error("PayPal webhook failed", error);
    return NextResponse.json({ error: "Could not process the event" }, { status: 500 });
  }
}
