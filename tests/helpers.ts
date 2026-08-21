import { PrismaClient, type Role } from "@prisma/client";

export const prisma = new PrismaClient();

let counter = 0;
const unique = () => `${Date.now().toString(36)}-${counter++}`;

export async function resetDatabase() {
  // Order matters: children first.
  await prisma.auditLog.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.invitation.deleteMany();
  await prisma.numberSequence.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.user.deleteMany();
  await prisma.company.deleteMany();
  await prisma.organization.deleteMany();
}

export async function makeCompany(name: string, baseCurrency = "PHP") {
  const organization = await prisma.organization.create({ data: { name: `${name} Group` } });
  return prisma.company.create({
    data: {
      organizationId: organization.id,
      name,
      baseCurrency,
      setupCompletedAt: new Date(),
    },
  });
}

export async function makeUser(role: Role, companyId: string, email?: string) {
  const user = await prisma.user.create({
    data: {
      email: email ?? `${role.toLowerCase()}-${unique()}@example.test`,
      name: `${role} ${unique()}`,
      passwordHash: "not-a-real-hash",
    },
  });
  await prisma.membership.create({ data: { userId: user.id, companyId, role } });
  return user;
}
