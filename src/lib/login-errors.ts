/**
 * What to tell someone whose sign-in did not work.
 *
 * Every failure used to arrive as "Wrong email or password", which is true for
 * one of the three cases and actively misleading for the other two: a throttled
 * person keeps typing, extending their own lockout, and an outage looks like a
 * typo so nobody reports it.
 *
 * Distinguishing them leaks nothing. The rate limit is counted before the user
 * lookup, so hitting it says nothing about whether the address exists, and an
 * outage is not about the account at all. Which password was wrong stays
 * unsaid.
 *
 * Module scope on purpose: a server action cannot capture a function from an
 * enclosing scope, so these have to live somewhere importable.
 */

export type LoginErrorCode = "credentials" | "throttled" | "unavailable";

const MESSAGES: Record<LoginErrorCode, string> = {
  credentials: "Wrong email or password.",
  throttled: "Too many attempts. Wait a few minutes and try again.",
  unavailable: "Sign-in is temporarily unavailable. Try again in a moment.",
};

export function loginErrorMessage(code: string | undefined): string {
  return MESSAGES[code as LoginErrorCode] ?? MESSAGES.credentials;
}

/**
 * Auth.js wraps whatever `authorize` threw, one or two layers deep and not
 * always under the same key, so walk the chain rather than guessing its shape.
 */
function* causes(error: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 4 || !error || typeof error !== "object") return;
  const record = error as Record<string, unknown>;
  yield record;
  yield* causes(record.cause, depth + 1);
  // CallbackRouteError puts the original under cause.err.
  const cause = record.cause;
  if (cause && typeof cause === "object") {
    yield* causes((cause as Record<string, unknown>).err, depth + 1);
  }
}

export function loginErrorCode(error: unknown): LoginErrorCode {
  let sawThrow = false;

  for (const link of causes(error)) {
    if (link.name === "RateLimitError") return "throttled";
    // authorize() returning null — a genuine credential mismatch.
    if (link.type === "CredentialsSignin" || link.name === "CredentialsSignin") {
      return "credentials";
    }
    // authorize() threw something. Which something, we find out above; if we
    // reach the end without recognising it, it was not a wrong password.
    if (link.type === "CallbackRouteError" || link.name === "CallbackRouteError") {
      sawThrow = true;
    }
  }

  return sawThrow ? "unavailable" : "credentials";
}
