import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { formatAccountingDate, isoDate, parseAccountingDate, today } from "@/lib/dates";
import { PostingError, RoleError } from "@/lib/errors";

/**
 * Month-end close (SPEC §4.2 rule 4).
 *
 * The lock itself is not here — it is one `assertPeriodOpen` inside
 * `postJournalEntry`, which every posting in the app goes through. All this
 * module does is move the one date that guard reads, and leave a trail of who
 * moved it and when.
 *
 * Two things are deliberate:
 *
 * Only month ends. `booksClosedThrough` is a plain DATE column and would accept
 * the 14th of a month happily. It should not: a period closed mid-month means
 * the P&L for that month can still change after it has been reported, which is
 * the exact thing closing a period exists to prevent.
 *
 * Only months that have ended. Closing the month you are standing in would
 * reject the rest of today's work with a message about the books being closed,
 * and the fix — reopen, post, close again — is not obvious from the message.
 */

/** The last day of the month containing `date`, at UTC midnight. */
export function monthEnd(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

export function isMonthEnd(date: Date): boolean {
  return date.getTime() === monthEnd(date).getTime();
}

/** "August 2026" — the month a close date names, for a person reading it. */
export function monthLabel(date: Date): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export type ClosableMonth = {
  /** yyyy-mm-dd, the last day of the month. The form value. */
  value: string;
  /** "August 2026 (through 08/31/2026)". */
  label: string;
  end: Date;
};

/**
 * The month ends an owner may choose, newest first.
 *
 * Bounded below by the earliest posting so the list does not run back to 1970,
 * and above by the last month that has ended. `earliest` being null means
 * nothing has been posted yet; there is then nothing to close, and the empty
 * list is what the page renders as "nothing to close yet".
 */
export function closableMonths(input: {
  earliest: Date | null;
  now?: Date;
  /** Cap, so a company with ten years of history gets a usable select. */
  limit?: number;
}): ClosableMonth[] {
  if (!input.earliest) return [];
  const now = input.now ?? today();
  const limit = input.limit ?? 36;

  // The most recent month that has finished. Standing in August, that is July.
  let cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const floor = monthEnd(input.earliest);

  const months: ClosableMonth[] = [];
  while (cursor >= floor && months.length < limit) {
    months.push({
      value: isoDate(cursor),
      label: `${monthLabel(cursor)} (through ${formatAccountingDate(cursor)})`,
      end: cursor,
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 0));
  }
  return months;
}

/** Parses and checks a close date from a form. Throws with a reason if unusable. */
export function parseCloseDate(input: string | null | undefined, now?: Date): Date {
  const date = parseAccountingDate(input);
  if (!date) throw new PostingError("Choose a month to close.");
  if (!isMonthEnd(date)) {
    throw new PostingError(
      `${formatAccountingDate(date)} is not a month end. Close through the last day of a month.`,
    );
  }
  const at = now ?? today();
  if (date >= new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))) {
    throw new PostingError(
      `${monthLabel(date)} has not ended yet. You can close it once it has.`,
    );
  }
  return date;
}

type Actor = { companyId: string; userId: string; role: Role };

function requireOwner(actor: Actor) {
  // The page hides the link and refuses the read, and the action checks again
  // here: a POST from a non-owner is not a mistake to render nicely.
  if (actor.role !== "OWNER") {
    throw new RoleError("Only an owner can close or reopen a period.");
  }
}

/**
 * Closes the books through `date`. Moving the date forward is a close; moving
 * it backward is a reopen, and is audited as one, because those are different
 * events to anyone reading the trail later.
 */
export async function closeBooksThrough(
  actor: Actor,
  date: Date,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  requireOwner(actor);

  const company = await client.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { booksClosedThrough: true },
  });
  const before = company.booksClosedThrough;

  if (before && before.getTime() === date.getTime()) return { changed: false, before };

  await client.company.update({
    where: { id: actor.companyId },
    data: { booksClosedThrough: date },
  });

  const reopening = before !== null && date < before;
  await writeAudit(
    {
      companyId: actor.companyId,
      userId: actor.userId,
      action: reopening ? "period.reopened" : "period.closed",
      entityType: "Company",
      entityId: actor.companyId,
      summary: reopening
        ? `Reopened back to ${formatAccountingDate(date)} from ${formatAccountingDate(before!)}`
        : `Closed through ${formatAccountingDate(date)}`,
      data: { from: before ? isoDate(before) : null, to: isoDate(date) },
    },
    client,
  );

  return { changed: true, before };
}

/** Reopens everything: no period is closed at all. */
export async function reopenAll(
  actor: Actor,
  client: Prisma.TransactionClient | typeof prisma = prisma,
) {
  requireOwner(actor);

  const company = await client.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { booksClosedThrough: true },
  });
  const before = company.booksClosedThrough;
  if (!before) return { changed: false, before };

  await client.company.update({
    where: { id: actor.companyId },
    data: { booksClosedThrough: null },
  });
  await writeAudit(
    {
      companyId: actor.companyId,
      userId: actor.userId,
      action: "period.reopened",
      entityType: "Company",
      entityId: actor.companyId,
      summary: `Reopened everything — was closed through ${formatAccountingDate(before)}`,
      data: { from: isoDate(before), to: null },
    },
    client,
  );

  return { changed: true, before };
}
