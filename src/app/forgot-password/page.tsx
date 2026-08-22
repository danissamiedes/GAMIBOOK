import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { generateToken, hashToken, resetExpiry } from "@/lib/tokens";
import { rateLimit } from "@/lib/rate-limit";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: "Reset your password — Ledger" };

/**
 * Self-service password reset (SPEC §2). Until Gmail is connected (Phase 7)
 * there is no mailbox to send from, so the link is shown on screen for an
 * admin to pass on — the same fallback the invite flow uses.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; link?: string; throttled?: string }>;
}) {
  const params = await searchParams;

  async function requestReset(formData: FormData) {
    "use server";
    const email = String(formData.get("email") || "").toLowerCase().trim();

    const headerList = await headers();
    const ip = headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    // Counted per IP, not per address, so saying so reveals nothing about who
    // has an account here. Reporting it as "sent" would leave someone waiting
    // for a link that was never made.
    const limit = await rateLimit(`reset:${ip}`, 5, 15 * 60);
    if (!limit.ok) redirect("/forgot-password?throttled=1");

    const user = await prisma.user.findUnique({ where: { email } });
    // Always report the same thing: never confirm whether an address exists.
    if (!user?.isActive) redirect("/forgot-password?sent=1");

    const token = generateToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt: resetExpiry() },
    });
    await writeAudit({
      userId: user.id,
      action: "password_reset.requested",
      entityType: "User",
      entityId: user.id,
    });

    redirect(`/forgot-password?sent=1&link=${encodeURIComponent(`/reset-password/${token}`)}`);
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Reset your password
      </h1>
      <Card>
        {params.throttled ? (
          <Alert tone="error">
            Too many reset requests from this connection. Wait a few minutes and try again.
          </Alert>
        ) : params.sent ? (
          <div className="space-y-3">
            <Alert tone="success">
              If that address belongs to an account, a reset link has been created.
            </Alert>
            {params.link ? (
              <Alert tone="warning">
                Email is not connected yet, so the link is shown here. It expires in 2 hours.
                <br />
                <Link className="mt-1 inline-block break-all underline" href={params.link}>
                  {params.link}
                </Link>
              </Alert>
            ) : null}
          </div>
        ) : (
          <form action={requestReset} className="space-y-4">
            <Field label="Email">
              <Input name="email" type="email" required autoFocus />
            </Field>
            <Button type="submit" className="w-full">
              Send reset link
            </Button>
          </form>
        )}
      </Card>
      <p className="mt-4 text-center text-sm">
        <Link className="text-slate-600 underline dark:text-slate-400" href="/login">
          Back to sign in
        </Link>
      </p>
    </main>
  );
}
