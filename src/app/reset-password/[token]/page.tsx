import { pageTitle } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: pageTitle("Choose a new password") };

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, isActive: true } } },
  });

  const valid =
    record && !record.usedAt && record.expiresAt > new Date() && record.user.isActive;

  async function setPassword(formData: FormData) {
    "use server";
    const password = String(formData.get("password") || "");
    const confirm = String(formData.get("confirm") || "");

    if (password.length < PASSWORD_MIN_LENGTH) redirect(`/reset-password/${token}?error=short`);
    if (password !== confirm) redirect(`/reset-password/${token}?error=mismatch`);

    const current = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, isActive: true } } },
    });
    if (!current || current.usedAt || current.expiresAt <= new Date() || !current.user.isActive) {
      redirect(`/reset-password/${token}?error=expired`);
    }

    const passwordHash = await hashPassword(password);
    await prisma.$transaction([
      prisma.user.update({ where: { id: current.userId }, data: { passwordHash } }),
      prisma.passwordResetToken.update({
        where: { id: current.id },
        data: { usedAt: new Date() },
      }),
      // Any other outstanding reset link for this user dies with it.
      prisma.passwordResetToken.updateMany({
        where: { userId: current.userId, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    await writeAudit({
      userId: current.userId,
      action: "password_reset.completed",
      entityType: "User",
      entityId: current.userId,
    });

    redirect("/login");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold text-slate-900 dark:text-slate-50">
        Choose a new password
      </h1>
      <Card>
        {!valid ? (
          <Alert tone="error">
            This link has expired or has already been used. Request a new one from the{" "}
            <Link className="underline" href="/forgot-password">
              reset page
            </Link>
            .
          </Alert>
        ) : (
          <form action={setPassword} className="space-y-4">
            {error === "short" ? (
              <Alert tone="error">Use at least {PASSWORD_MIN_LENGTH} characters.</Alert>
            ) : null}
            {error === "mismatch" ? <Alert tone="error">The passwords do not match.</Alert> : null}
            {error === "expired" ? <Alert tone="error">This link has expired.</Alert> : null}
            <p className="text-sm text-slate-600 dark:text-slate-400">{record?.user.email}</p>
            <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
              <Input name="password" type="password" autoComplete="new-password" required autoFocus />
            </Field>
            <Field label="Confirm password">
              <Input name="confirm" type="password" autoComplete="new-password" required />
            </Field>
            <Button type="submit" className="w-full">
              Set password and sign in
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
