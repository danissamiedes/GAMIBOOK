import type { JournalSourceType, Prisma, Role } from "@prisma/client";
import { PostingError } from "@/lib/errors";
import { accountingDate, postJournalEntry, reverseJournalEntry, type PostLineInput } from "./post";

/**
 * Correcting a document that has already posted (SPEC §4.2 rule 3).
 *
 * A posted entry is immutable, so an edit is two postings, never a mutation:
 * reverse what was written, then write what it should have said. Both go
 * through `postJournalEntry`, which is what keeps rule 5 true and what applies
 * the closed-period gate (rule 4) to each of them.
 *
 * **The dates matter more than they look.** The reversal is dated to the
 * *original* entry, not to today. Correcting an invoice dated 15 August on 22
 * August with a reversal dated the 22nd would leave August overstated and
 * September understated until someone noticed; dating the reversal back to the
 * 15th makes the correction disappear from both months' totals, which is what
 * "this was always wrong" means. The repost carries the document's own date,
 * which may itself have been part of the edit.
 *
 * The cost of that choice is that a correction can land in a closed period.
 * That is not a hole: `postJournalEntry` rejects it for anyone but an OWNER,
 * and an owner reopening August to fix August is a decision they are allowed
 * to make.
 */
export async function amendPosting(
  input: {
    companyId: string;
    sourceType: JournalSourceType;
    sourceId: string;
    /** The corrected document's date — where the new entry lands. */
    date: Date;
    memo?: string | null;
    lines: PostLineInput[];
    userId?: string | null;
    role?: Role | null;
  },
  tx: Prisma.TransactionClient,
) {
  const original = await liveEntryFor(input.companyId, input.sourceType, input.sourceId, tx);

  const reversal = await reverseJournalEntry(
    {
      companyId: input.companyId,
      entryId: original.id,
      // Back to where it was written. See the note above.
      date: original.date,
      memo: `Correction of entry ${original.entryNumber}`,
      userId: input.userId,
      role: input.role,
    },
    tx,
  );

  const reposted = await postJournalEntry(
    {
      companyId: input.companyId,
      date: accountingDate(input.date),
      memo: input.memo ?? original.memo,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      userId: input.userId,
      role: input.role,
      lines: input.lines,
    },
    tx,
  );

  return { original, reversal, reposted };
}

/**
 * The one posting a document currently stands on: not itself a reversal, and
 * not already reversed.
 *
 * A document may carry several entries once it has been corrected a few times
 * — the original, its reversal, the repost, and so on — and only one of them
 * is live. Anything else is a state this code does not understand well enough
 * to correct safely, so it refuses rather than guesses.
 */
export async function liveEntryFor(
  companyId: string,
  sourceType: JournalSourceType,
  sourceId: string,
  tx: Prisma.TransactionClient,
) {
  const entries = await tx.journalEntry.findMany({
    where: { companyId, sourceType, sourceId },
    orderBy: { postedAt: "asc" },
    include: { reverses: { select: { id: true } } },
  });

  const live = entries.filter(
    (entry) => entry.reversedByEntryId === null && entry.reverses === null,
  );

  if (live.length === 0) {
    throw new PostingError(
      "This document has no posting standing against it, so there is nothing to correct.",
    );
  }
  if (live.length > 1) {
    throw new PostingError(
      "This document has more than one posting standing against it. Void it and record it again.",
    );
  }

  return live[0];
}
