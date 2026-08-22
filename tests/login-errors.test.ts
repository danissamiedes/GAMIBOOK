import { describe, expect, it } from "vitest";
import { loginErrorCode, loginErrorMessage } from "@/lib/login-errors";
import { RateLimitError } from "@/lib/errors";

/**
 * Auth.js's own classes cannot be imported here — next-auth pulls in Next
 * internals vitest will not resolve — so these reproduce the shapes its
 * constructor actually builds, read out of @auth/core/errors.js:
 *
 *   AuthError sets  name = constructor.name  and  type = constructor.type
 *   new CallbackRouteError(e, opts) sets  cause = { err: e, ...e.cause, ...opts }
 *
 * If Auth.js changes that, these stop reflecting reality — the wrapping is
 * checked against the library in the comment above, not asserted at runtime.
 */
function credentialsSignin() {
  return { name: "CredentialsSignin", type: "CredentialsSignin" };
}

function callbackRouteError(original: unknown) {
  return {
    name: "CallbackRouteError",
    type: "CallbackRouteError",
    cause: { err: original, provider: "credentials" },
  };
}

/**
 * Every sign-in failure used to read "Wrong email or password", which is true
 * for one of these three and misleading for the other two. Told their password
 * is wrong, a throttled person keeps trying and extends their own lockout; an
 * outage looks like a typo and goes unreported.
 */
describe("what a failed sign-in is told", () => {
  it("calls a wrong password a wrong password", () => {
    expect(loginErrorCode(credentialsSignin())).toBe("credentials");
  });

  it("recognises the rate limiter through Auth.js's wrapping", () => {
    const thrown = new RateLimitError(420);
    expect(loginErrorCode(callbackRouteError(thrown))).toBe("throttled");
  });

  it("recognises it however deeply it is nested", () => {
    const thrown = new RateLimitError(60);
    expect(loginErrorCode({ cause: { err: { cause: thrown } } })).toBe("throttled");
  });

  it("treats any other thrown error as an outage, not a bad password", () => {
    const dbDown = new Error("Can't reach database server at aws-1-ap-southeast-1.pooler...");
    expect(loginErrorCode(callbackRouteError(dbDown))).toBe("unavailable");
  });

  it("falls back to the credential message when the shape is unrecognisable", () => {
    expect(loginErrorCode(undefined)).toBe("credentials");
    expect(loginErrorCode("something")).toBe("credentials");
    expect(loginErrorCode({})).toBe("credentials");
  });

  it("does not loop forever on a self-referencing cause chain", () => {
    const looped: Record<string, unknown> = {};
    looped.cause = looped;
    expect(loginErrorCode(looped)).toBe("credentials");
  });

  it("maps each code to its own message, and an unknown code to the safe one", () => {
    expect(loginErrorMessage("throttled")).toMatch(/too many/i);
    expect(loginErrorMessage("unavailable")).toMatch(/unavailable/i);
    expect(loginErrorMessage("credentials")).toMatch(/wrong email or password/i);
    // Old links carried ?error=1, and anything unrecognised must not blank the alert.
    expect(loginErrorMessage("1")).toMatch(/wrong email or password/i);
    expect(loginErrorMessage(undefined)).toMatch(/wrong email or password/i);
  });

  it("never reveals whether the address exists", () => {
    for (const code of ["credentials", "throttled", "unavailable", "1", undefined]) {
      expect(loginErrorMessage(code)).not.toMatch(/no such|not found|unknown user|no account/i);
    }
  });
});
