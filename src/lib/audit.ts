import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Append-only audit trail (SPEC §13). Written for every financial document and
 * every user/role change. Never updated, never deleted.
 */
export type AuditInput = {
  companyId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: string | null;
  data?: Prisma.InputJsonValue;
};

export async function writeAudit(
  input: AuditInput,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return client.auditLog.create({
    data: {
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary ?? null,
      data: input.data,
    },
  });
}
