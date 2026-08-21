import { redirect } from "next/navigation";

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
