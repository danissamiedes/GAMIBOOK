import { redirect } from "next/navigation";
import { ConfigurationError } from "@/lib/errors";

/**
 * Send the user back to a screen with an error on it.
 *
 * This exists as a module function rather than a closure inside each page for
 * a reason worth remembering: a server action captures the variables around
 * it, and Next serialises that capture. A captured *function* cannot be
 * serialised, so `const fail = (message) => redirect(...)` next to an action
 * throws "Functions cannot be passed directly to Client Components" on every
 * render of that page. The pages still answered 200 and the error only showed
 * in the server log, which is exactly why it survived five screens.
 *
 * Taking the path as an argument keeps this free of any capture.
 */
export function failTo(path: string, message: string): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

/**
 * Runs part of a server action and puts a `ConfigurationError` on the screen
 * instead of letting it become a 500. The deployment is missing a setting, the
 * message names it, and nobody should have to read a server log to find out.
 */
export async function failToOnMisconfiguration<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof ConfigurationError) failTo(path, thrown.message);
    throw thrown;
  }
}
