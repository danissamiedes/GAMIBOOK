import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { hashPassword, PASSWORD_MIN_LENGTH } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

export const metadata = { title: "Accept your invitation — Ledger" };

/**
 * Invite acceptance (SPEC §2): the invitee sets their own password on first
 * use. Short, plain, and usable on a phone — consultants are the least
 * technical people in this system.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;

  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { company: { select: { name: true } } },
  });

  const valid = invite && !invite.acceptedAt && !invite.revokedAt && invite.expiresAt > new Date();

  async function accept(formData: FormData) {
    "use server";
    const name = String(formData.get("name") || "").trim();
    const password = String(formData.get("password") || "");
    const confirm = String(formData.get("confirm") || "");

    if (!name) redirect(`/invite/${token}?error=name`);
    if (password.length < PASSWORD_MIN_LENGTH) redirect(`/invite/${token}?error=short`);
    if (password !== confirm) redirect(`/invite/${token}?error=mismatch`);

    const current = await prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!current || current.acceptedAt || current.revokedAt || current.expiresAt <= new Date()) {
      redirect(`/invite/${token}?error=expired`);
    }

    const email = current.email.toLowerCase();
    const passwordHash = await hashPassword(password);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({
        where: { email },
        select: { id: true, passwordHash: true },
      });

      // An existing user accepting an invite to a second company keeps the
      // password they already have; only someone who never set one gets this.
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { name, isActive: true, ...(existing.passwordHash ? {} : { passwordHash }) },
          })
        : await tx.user.create({ data: { email, name, passwordHash } });

      await tx.membership.upsert({
        where: { userId_companyId: { userId: user.id, companyId: current.companyId } },
        create: { userId: user.id, companyId: current.companyId, role: current.role },
        update: { role: current.role },
      });

      await tx.invitation.update({
        where: { id: current.id },
        data: { acceptedAt: new Date() },
      });

      await writeAudit(
        {
          companyId: current.companyId,
          userId: user.id,
          action: "invite.accepted",
          entityType: "Membership",
          entityId: user.id,
          summary: `${email} joined as ${current.role}`,
        },
        tx,
      );
    });

    redirect("/login");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">Ledger</h1>
      {valid ? (
        <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
          You have been invited to {invite.company.name} as {invite.role.toLowerCase()}. Set a
          password to finish.
        </p>
      ) : null}
      <Card>
        {!valid ? (
          <Alert tone="error">
            This invitation has expired or has already been used. Ask whoever invited you to send a
            new one.
          </Alert>
        ) : (
          <form action={accept} className="space-y-4">
            {error === "name" ? <Alert tone="error">Please give your name.</Alert> : null}
            {error === "short" ? (
              <Alert tone="error">Use at least {PASSWORD_MIN_LENGTH} characters.</Alert>
            ) : null}
            {error === "mismatch" ? <Alert tone="error">The passwords do not match.</Alert> : null}
            {error === "expired" ? <Alert tone="error">This invitation has expired.</Alert> : null}
            <p className="text-sm text-slate-600 dark:text-slate-400">{invite.email}</p>
            <Field label="Your name">
              <Input name="name" required autoFocus />
            </Field>
            <Field label="Password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
              <Input name="password" type="password" autoComplete="new-password" required />
            </Field>
            <Field label="Confirm password">
              <Input name="confirm" type="password" autoComplete="new-password" required />
            </Field>
            <Button type="submit" className="w-full">
              Create my account
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
