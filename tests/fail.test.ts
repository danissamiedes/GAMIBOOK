import { describe, expect, it } from "vitest";
import { failTo } from "@/lib/fail";

/**
 * `failTo` replaced a `const fail = …` closure that sat next to a server
 * action on five screens. A server action serialises what it captures, and a
 * captured function cannot be serialised — so every render of those pages
 * logged "Functions cannot be passed directly to Client Components" while
 * still answering 200, which is why it went unnoticed. These cover the only
 * logic the extraction added.
 */
function redirectTarget(run: () => never): string {
  try {
    run();
  } catch (thrown) {
    const digest = (thrown as { digest?: string }).digest ?? "";
    expect(digest).toContain("NEXT_REDIRECT");
    // digest is "NEXT_REDIRECT;replace;<url>;..."
    return digest.split(";")[2];
  }
  throw new Error("failTo did not redirect");
}

describe("failTo", () => {
  it("adds the error to a plain path", () => {
    expect(redirectTarget(() => failTo("/consultant-bills", "Enter the amount"))).toBe(
      "/consultant-bills?error=Enter%20the%20amount",
    );
  });

  it("keeps a query string the caller already built", () => {
    // The expenses screen carries its tab through the failure, or the user is
    // dropped back on a different tab from the one they were filling in.
    expect(redirectTarget(() => failTo("/expenses?tab=bills", "Pick a vendor"))).toBe(
      "/expenses?tab=bills&error=Pick%20a%20vendor",
    );
  });

  it("escapes a message that would otherwise break the URL", () => {
    const target = redirectTarget(() =>
      failTo("/invoices/abc", "Rate & quantity must both be set — check line 2"),
    );
    expect(target).not.toContain(" ");
    expect(new URL(target, "http://x").searchParams.get("error")).toBe(
      "Rate & quantity must both be set — check line 2",
    );
  });
});
