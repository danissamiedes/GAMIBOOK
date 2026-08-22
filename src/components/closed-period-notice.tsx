import { prisma } from "@/lib/db";
import { formatAccountingDate, isoDate } from "@/lib/dates";
import { ClosedPeriodWatcher } from "@/components/closed-period-watcher";
import type { Role } from "@prisma/client";

/**
 * Mounts the closed-period warning for an owner, and renders nothing at all for
 * anyone else — no component, no date on the page, nothing to read.
 */
export async function ClosedPeriodNotice({
  companyId,
  role,
}: {
  companyId: string;
  role: Role;
}) {
  if (role !== "OWNER") return null;

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { booksClosedThrough: true },
  });
  if (!company?.booksClosedThrough) return null;

  return (
    <ClosedPeriodWatcher
      closedThrough={isoDate(company.booksClosedThrough)}
      display={formatAccountingDate(company.booksClosedThrough)}
    />
  );
}
