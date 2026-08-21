import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { Role } from "@prisma/client";
import { currentUserId } from "@/lib/auth";
import { withCompanyScope } from "@/lib/company-scope";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { prisma } from "@/lib/db";
import { generateToken, hashToken, inviteExpiry } from "@/lib/tokens";
import { writeAudit } from "@/lib/audit";
import { Alert, Button, Card, Field, Input, PageHeader, Select } from "@/components/ui";

export const metadata = { title: "Users — Ledger" };

/**
 * User and role management is OWNER-only (SPEC §2). Invites carry the role and
 * company and expire in 7 days. Gmail is not connected until Phase 7, so the
 * invite link is shown for copying — the fallback SPEC §2 asks for.
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ link?: string; error?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const activeId = await resolveActiveCompanyId(userId);
  const scope = await withCompanyScope(userId, activeId);
  const { link, error } = await searchParams;

  // Read path: refuse politely. The server actions below still call
  // requireRole(), because a POST from a non-owner is not a mistake to be
  // rendered nicely — it is an attempt to be rejected.
  if (!scope.hasRole("OWNER")) {
    return (
      <>
        <PageHeader title="Users" />
        <Alert tone="warning">
          Only an owner can manage users and roles. Your role in this company is{" "}
          {scope.role.toLowerCase()}.
        </Alert>
      </>
    );
  }

  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: scope.where,
      include: { user: { select: { id: true, name: true, email: true, isActive: true, lastLoginAt: true } } },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.invitation.findMany({
      where: { ...scope.where, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  async function invite(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    const cid = await resolveActiveCompanyId(uid ?? "");
    const inner = await withCompanyScope(uid, cid);
    inner.requireRole("OWNER");

    const email = String(formData.get("email") || "").toLowerCase().trim();
    const role = String(formData.get("role") || "") as Role;
    if (!email.includes("@")) redirect("/settings/users?error=email");
    if (!["OWNER", "BOOKKEEPER", "CONSULTANT"].includes(role)) redirect("/settings/users?error=role");

    const existing = await prisma.membership.findFirst({
      where: { companyId: inner.companyId, user: { email } },
    });
    if (existing) redirect("/settings/users?error=member");

    const token = generateToken();
    const invitation = await prisma.invitation.create({
      data: {
        companyId: inner.companyId,
        email,
        role,
        tokenHash: hashToken(token),
        expiresAt: inviteExpiry(),
        invitedByUserId: inner.userId,
      },
    });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "invite.created",
      entityType: "Invitation",
      entityId: invitation.id,
      summary: `${email} invited as ${role}`,
    });

    const host = (await headers()).get("host") ?? "localhost:3000";
    const proto = process.env.NODE_ENV === "production" ? "https" : "http";
    redirect(`/settings/users?link=${encodeURIComponent(`${proto}://${host}/invite/${token}`)}`);
  }

  async function revoke(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    const cid = await resolveActiveCompanyId(uid ?? "");
    const inner = await withCompanyScope(uid, cid);
    inner.requireRole("OWNER");

    const id = String(formData.get("invitationId") || "");
    // companyId in the filter is what stops an id from another company working.
    const result = await prisma.invitation.updateMany({
      where: { id, companyId: inner.companyId, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count > 0) {
      await writeAudit({
        companyId: inner.companyId,
        userId: inner.userId,
        action: "invite.revoked",
        entityType: "Invitation",
        entityId: id,
      });
    }
    redirect("/settings/users");
  }

  async function changeRole(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    const cid = await resolveActiveCompanyId(uid ?? "");
    const inner = await withCompanyScope(uid, cid);
    inner.requireRole("OWNER");

    const membershipId = String(formData.get("membershipId") || "");
    const role = String(formData.get("role") || "") as Role;
    if (!["OWNER", "BOOKKEEPER", "CONSULTANT"].includes(role)) redirect("/settings/users");

    const membership = await prisma.membership.findFirst({
      where: { id: membershipId, companyId: inner.companyId },
    });
    if (!membership) redirect("/settings/users");

    // Never leave a company without an owner.
    if (membership.role === "OWNER" && role !== "OWNER") {
      const owners = await prisma.membership.count({
        where: { companyId: inner.companyId, role: "OWNER" },
      });
      if (owners <= 1) redirect("/settings/users?error=lastowner");
    }

    await prisma.membership.update({ where: { id: membership.id }, data: { role } });
    await writeAudit({
      companyId: inner.companyId,
      userId: inner.userId,
      action: "membership.role_changed",
      entityType: "Membership",
      entityId: membership.id,
      data: { from: membership.role, to: role },
    });
    redirect("/settings/users");
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Roles apply to this company only. The same person can hold a different role elsewhere."
      />

      {error === "member" ? <Alert tone="error">That person is already a member.</Alert> : null}
      {error === "email" ? <Alert tone="error">Enter a valid email address.</Alert> : null}
      {error === "lastowner" ? (
        <Alert tone="error">This is the last owner — promote someone else first.</Alert>
      ) : null}
      {link ? (
        <Alert tone="warning">
          Email is not connected yet, so send this link yourself. It expires in 7 days.
          <br />
          <span className="mt-1 inline-block break-all font-mono text-xs">{link}</span>
        </Alert>
      ) : null}

      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Members</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800">
                <th className="py-2">Name</th>
                <th className="py-2">Email</th>
                <th className="py-2">Role</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} className="border-b border-slate-100 dark:border-slate-800/60">
                  <td className="py-2">{member.user.name}</td>
                  <td className="py-2 text-slate-600 dark:text-slate-400">{member.user.email}</td>
                  <td className="py-2">
                    <form action={changeRole} className="flex items-center gap-2">
                      <input type="hidden" name="membershipId" value={member.id} />
                      <Select name="role" defaultValue={member.role} className="w-40">
                        <option value="OWNER">Owner</option>
                        <option value="BOOKKEEPER">Bookkeeper</option>
                        <option value="CONSULTANT">Consultant</option>
                      </Select>
                      <Button variant="secondary" type="submit">
                        Save
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {invitations.length > 0 ? (
            <>
              <h2 className="mt-6 mb-3 text-sm font-semibold">Pending invitations</h2>
              <ul className="space-y-2 text-sm">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center justify-between gap-3">
                    <span>
                      {invitation.email}{" "}
                      <span className="text-slate-500">
                        · {invitation.role.toLowerCase()} · expires{" "}
                        {invitation.expiresAt.toISOString().slice(0, 10)}
                      </span>
                    </span>
                    <form action={revoke}>
                      <input type="hidden" name="invitationId" value={invitation.id} />
                      <Button variant="ghost" type="submit">
                        Revoke
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Invite someone</h2>
          <form action={invite} className="space-y-4">
            <Field label="Email">
              <Input name="email" type="email" required />
            </Field>
            <Field
              label="Role"
              hint="A consultant sees only the time clock — no financial data at all."
            >
              <Select name="role" defaultValue="BOOKKEEPER">
                <option value="OWNER">Owner</option>
                <option value="BOOKKEEPER">Bookkeeper</option>
                <option value="CONSULTANT">Consultant</option>
              </Select>
            </Field>
            <Button type="submit">Create invitation</Button>
          </form>
          <p className="mt-3 text-xs text-slate-500">
            Once Gmail is connected (Phase 7) these go out by email instead.{" "}
            <Link className="underline" href="/settings/company">
              Company settings
            </Link>
          </p>
        </Card>
      </div>
    </>
  );
}
