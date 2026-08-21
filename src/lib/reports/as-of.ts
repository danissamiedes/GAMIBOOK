import type { JournalSourceType } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Reading a document's state *as at a date*, rather than as it stands now.
 *
 * Aging is the report that needs this. Both aging reports used to read each
 * document's current `balanceDue`, so "A/P as at 31 July" showed what is open
 * today — a document settled in August looked settled in July, and a report
 * run for a closed period quietly disagreed with the ledger for that period.
 *
 * Two things decide whether a document was outstanding on a date, and both
 * turn on an *accounting* date rather than a wall-clock one:
 *
 *   - was it voided? `voidedAt` records when someone clicked, but the void
 *     posts a reversing entry carrying the date the books use.
 *   - had a payment landed? Same story: `reversedAt` is the click,
 *     `reversalEntryId` points at the entry with the accounting date.
 *
 * Taking the timestamps instead would misfile anything reversed in one period
 * for another, which is precisely the case a historical aging exists to show.
 */

/** True when a reversal had not yet posted as at `asOf`. */
export function liveAt(reversedOn: Date | undefined, asOf: Date): boolean {
  return reversedOn === undefined || reversedOn > asOf;
}

/**
 * For documents of one source type, the accounting date on which each was
 * reversed — a void, in practice. Keyed by document id.
 */
export async function voidDates(
  companyId: string,
  sourceType: JournalSourceType,
  documentIds: string[],
): Promise<Map<string, Date>> {
  if (documentIds.length === 0) return new Map();
  const entries = await prisma.journalEntry.findMany({
    where: {
      companyId,
      sourceType,
      sourceId: { in: documentIds },
      reversedByEntryId: { not: null },
    },
    select: { sourceId: true, reversedBy: { select: { date: true } } },
  });
  const dates = new Map<string, Date>();
  for (const entry of entries) {
    if (entry.sourceId && entry.reversedBy)
      dates.set(entry.sourceId, entry.reversedBy.date);
  }
  return dates;
}

/**
 * The accounting date each reversal posted, keyed by the *reversal entry id*
 * a payment record points at.
 */
export async function reversalDates(
  entryIds: (string | null)[],
): Promise<Map<string, Date>> {
  const ids = entryIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Map();
  const entries = await prisma.journalEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, date: true },
  });
  return new Map(entries.map((entry) => [entry.id, entry.date]));
}
