import { ConfigurationError } from "@/lib/errors";

/**
 * PayPal REST client, narrow on purpose (SPEC §16).
 *
 * Four calls are all this app makes: get a token, create a subscription, read
 * one back, cancel one. Everything else about a subscription — retries, dunning
 * emails, the payer changing their card — is PayPal's job, and reimplementing
 * any of it here would mean two systems disagreeing about who has paid.
 *
 * Sandbox and live are different hosts with different credentials, and the
 * environment picks which. That is deliberate rather than a `NODE_ENV` check:
 * testing a payment flow against live money because a build flag said
 * "production" is the failure this prevents.
 */

const HOSTS = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
} as const;

export type PayPalEnvironment = keyof typeof HOSTS;

export function paypalEnvironment(): PayPalEnvironment {
  return process.env.PAYPAL_ENVIRONMENT === "live" ? "live" : "sandbox";
}

/** True when the credentials needed to talk to PayPal at all are present. */
export function paypalConfigured(): boolean {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

/** The plan id to bill the software subscription on. */
export function systemPlanId(): string | undefined {
  return process.env.PAYPAL_SYSTEM_PLAN_ID || undefined;
}

/**
 * Everything checkout needs, or a reason it cannot run. Returned rather than
 * thrown so a page can explain the gap instead of showing a stack trace — the
 * person who has to fix it is the operator, not the visitor.
 */
export function checkoutReadiness(): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!process.env.PAYPAL_CLIENT_ID) missing.push("PAYPAL_CLIENT_ID");
  if (!process.env.PAYPAL_CLIENT_SECRET) missing.push("PAYPAL_CLIENT_SECRET");
  if (!systemPlanId()) missing.push("PAYPAL_SYSTEM_PLAN_ID");
  return { ready: missing.length === 0, missing };
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

function credentials(): { id: string; secret: string } {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new ConfigurationError(
      "PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.",
    );
  }
  return { id, secret };
}

/**
 * An access token, cached until shortly before it expires.
 *
 * PayPal's tokens last hours, so fetching one per request would be a needless
 * round trip on every checkout. The margin is a minute: a token that expires
 * in flight fails the call it was fetched for, which is the one failure mode
 * worth spending a minute of validity to avoid.
 */
let cached: { token: string; expiresAt: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const { id, secret } = credentials();
  const response = await fetch(`${HOSTS[paypalEnvironment()]}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new PayPalError(
      json.error_description ?? `Could not get a PayPal token (${response.status})`,
      response.status,
    );
  }

  cached = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(0, (json.expires_in ?? 0) - 60) * 1000,
  };
  return cached.token;
}

/** Drops the cached token. For tests, and for a credentials change. */
export function forgetToken() {
  cached = null;
}

async function call<T>(path: string, init: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(`${HOSTS[paypalEnvironment()]}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "content-type": "application/json",
      ...(rest.headers ?? {}),
    },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  });

  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = Array.isArray(body.details) ? body.details[0] : undefined;
    throw new PayPalError(
      String(
        (detail as { description?: string } | undefined)?.description ??
          body.message ??
          `PayPal rejected the request (${response.status})`,
      ),
      response.status,
    );
  }
  return body as T;
}

export type CreatedSubscription = {
  id: string;
  status: string;
  /** Where to send the payer to approve it. */
  approveUrl: string;
};

/**
 * Start a subscription. The payer is not charged until they approve it at the
 * returned URL, so nothing here commits anyone to anything.
 *
 * `customId` carries our own organization id through PayPal and back out in
 * every webhook about this subscription. Matching on the payer's email instead
 * is the obvious shortcut and a bad one: people pay from a different PayPal
 * account than the one they signed up with all the time.
 */
export async function createSubscription(options: {
  planId: string;
  customId: string;
  subscriberEmail: string;
  subscriberName?: string;
  returnUrl: string;
  cancelUrl: string;
}): Promise<CreatedSubscription> {
  const body = await call<{
    id: string;
    status: string;
    links?: { rel: string; href: string }[];
  }>("/v1/billing/subscriptions", {
    method: "POST",
    json: {
      plan_id: options.planId,
      custom_id: options.customId,
      subscriber: {
        email_address: options.subscriberEmail,
        ...(options.subscriberName ? { name: { given_name: options.subscriberName } } : {}),
      },
      application_context: {
        brand_name: "GAMIBOOK",
        user_action: "SUBSCRIBE_NOW",
        shipping_preference: "NO_SHIPPING",
        return_url: options.returnUrl,
        cancel_url: options.cancelUrl,
      },
    },
  });

  const approveUrl = body.links?.find((link) => link.rel === "approve")?.href;
  if (!approveUrl) {
    throw new PayPalError("PayPal created the subscription but returned no approval link");
  }
  return { id: body.id, status: body.status, approveUrl };
}

export type RemoteSubscription = {
  id: string;
  status: string;
  custom_id?: string;
  plan_id?: string;
  subscriber?: { email_address?: string };
  billing_info?: { next_billing_time?: string };
};

/**
 * Read a subscription back from PayPal.
 *
 * This is the authority, not our own row. When the two disagree — a webhook
 * lost, a status changed while the app was down — this is what settles it.
 */
export async function getSubscription(id: string): Promise<RemoteSubscription> {
  return call<RemoteSubscription>(`/v1/billing/subscriptions/${encodeURIComponent(id)}`, {
    method: "GET",
  });
}

export async function cancelSubscription(id: string, reason: string): Promise<void> {
  await call<void>(`/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    json: { reason: reason.slice(0, 128) },
  });
}

/**
 * Ask PayPal whether a webhook really came from PayPal.
 *
 * Verification is a call back to PayPal rather than a local signature check.
 * That is PayPal's design, not a shortcut: the certificate the signature is
 * made with rotates, and this endpoint is what knows the current one.
 *
 * Returns false when PAYPAL_WEBHOOK_ID is unset, because an unverifiable
 * webhook and a forged one are indistinguishable, and treating "cannot check"
 * as "must be fine" is how an endpoint that grants paid access gets abused.
 */
export async function verifyWebhook(options: {
  headers: Headers;
  body: string;
}): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;

  const header = (name: string) => options.headers.get(name) ?? "";
  const required = [
    "paypal-transmission-id",
    "paypal-transmission-time",
    "paypal-transmission-sig",
    "paypal-cert-url",
    "paypal-auth-algo",
  ];
  if (required.some((name) => !header(name))) return false;

  try {
    const result = await call<{ verification_status?: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        json: {
          auth_algo: header("paypal-auth-algo"),
          cert_url: header("paypal-cert-url"),
          transmission_id: header("paypal-transmission-id"),
          transmission_sig: header("paypal-transmission-sig"),
          transmission_time: header("paypal-transmission-time"),
          webhook_id: webhookId,
          // The event must go back as PayPal sent it. Re-serializing a parsed
          // object reorders keys and the signature stops matching.
          webhook_event: JSON.parse(options.body),
        },
      },
    );
    return result.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}
