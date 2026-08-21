import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth";
import { withSectionScope } from "@/lib/company-scope";
import { connectMailbox } from "@/lib/email/gmail";
import { writeAudit } from "@/lib/audit";
import { requestOrigin } from "@/lib/request-origin";

/**
 * OAuth callback (SPEC §10). `state` carries the company the connection is
 * for, and membership in that company is re-checked here — a callback URL is
 * not a capability.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) redirect(`/settings/email?error=${encodeURIComponent(error)}`);
  if (!code || !state)
    redirect("/settings/email?error=Google%20returned%20no%20code");

  const userId = await currentUserId();
  if (!userId) redirect("/login");

  // Proves the caller may connect a mailbox for this company.
  const scope = await withSectionScope(userId, state, "SETTINGS");

  try {
    const connection = await connectMailbox({
      companyId: scope.companyId,
      code,
      origin: requestOrigin(request.headers),
      userId,
    });
    await writeAudit({
      companyId: scope.companyId,
      userId,
      action: "email.connected",
      entityType: "EmailConnection",
      entityId: connection.id,
      summary: connection.emailAddress,
    });
  } catch (thrown) {
    const message =
      thrown instanceof Error ? thrown.message : "Could not connect";
    redirect(`/settings/email?error=${encodeURIComponent(message)}`);
  }

  redirect("/settings/email?connected=1");
}
