import { prisma } from "@/lib/db";

/**
 * A hold that ran out (SPEC §17).
 *
 * The grid has always ignored an expired hold — a court does not stay off the
 * market because somebody opened a form and wandered off — but the booking row
 * itself stayed HELD, so the venue's "Awaiting payment" list filled up with
 * people who were never coming, and the booker's own page still invited them to
 * pay for slots that were already back on sale.
 *
 * Expiry is therefore settled in two places, on purpose:
 *
 *   `isExpiredHold` is read-time truth. It needs no scheduler, so the page, the
 *   grid and the proof upload agree the instant the minute passes, even on a
 *   host where nothing is running between requests.
 *
 *   `expireStaleHolds` is the tidy-up, run from the scheduler. It writes what
 *   the readers already assume, so the lists a person works from are accurate
 *   rather than quietly filtered.
 *
 * It sends nothing. A booker whose fifteen minutes lapsed gets their page
 * saying so when they look at it, and an unprompted email about a reservation
 * somebody abandoned is noise, not service.
 */

export type HoldLike = { status: string; heldUntil: Date | null };

/** True when this is a hold whose time is up. */
export function isExpiredHold(group: HoldLike, now = new Date()): boolean {
  return group.status === "HELD" && group.heldUntil !== null && group.heldUntil <= now;
}

export const HOLD_EXPIRED_REASON = "The hold ran out before payment arrived.";

/**
 * Cancel every hold whose time is up, releasing its slots.
 *
 * Idempotent: a group already cancelled no longer matches, so running this
 * every five minutes or every five seconds does the same work. The slot rows
 * are moved too, because the partial unique index that stops double-booking
 * reads the status on the slot, not on the group.
 */
export async function expireStaleHolds(now = new Date()): Promise<{ expired: number }> {
  const stale = await prisma.bookingGroup.findMany({
    where: { status: "HELD", heldUntil: { lt: now } },
    select: { id: true },
  });
  if (stale.length === 0) return { expired: 0 };

  const ids = stale.map((group) => group.id);
  await prisma.$transaction([
    prisma.booking.updateMany({
      where: { groupId: { in: ids } },
      data: { status: "CANCELLED" },
    }),
    prisma.bookingGroup.updateMany({
      where: { id: { in: ids }, status: "HELD" },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelReason: HOLD_EXPIRED_REASON,
        heldUntil: null,
      },
    }),
  ]);

  return { expired: ids.length };
}
