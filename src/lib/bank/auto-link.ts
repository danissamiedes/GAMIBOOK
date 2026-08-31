import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { linkToPayment, suggestCandidates } from "./match";

/**
 * Linking the bank lines that can only mean one thing (SPEC §8.4).
 *
 * Of the three match outcomes, only the first is safe to do without a person:
 *
 *   - **LINK posts nothing.** The payment is already in the ledger; the bank
 *     line is the bank confirming it. Linking points the line at the entry that
 *     payment already wrote. Get it wrong and the fix is to unmatch, which
 *     leaves the books exactly as they were.
 *   - **SETTLE and CATEGORISE both create postings.** A wrong guess there is a
 *     wrong ledger, and no confidence score is worth that. They stay manual.
 *
 * Even within LINK this is deliberately timid. `suggestCandidates` already
 * requires an exact amount within five days; this additionally requires that
 * there be **exactly one** such candidate. Two candidates for the same figure
 * is precisely the case a person should look at — the same amount to the same
 * party twice in a week is either a duplicate or two real payments, and
 * guessing gets it wrong half the time.
 *
 * Off until a company turns it on, like reminders.
 */

/** Bank lines with exactly one possible payment behind them. */
export async function unambiguousMatches(options: { companyId: string; limit?: number }) {
  const unmatched = await prisma.bankTransaction.findMany({
    where: {
      companyId: options.companyId,
      status: "UNMATCHED",
    },
    orderBy: { date: "asc" },
    take: options.limit ?? 100,
  });

  const found = [];
  for (const transaction of unmatched) {
    const candidates = await suggestCandidates({
      companyId: options.companyId,
      transactionId: transaction.id,
    });
    // Exactly one, and it must land on the same day. A five-day gap is fine for
    // a person weighing one option against another; it is not enough on its
    // own to act unattended.
    if (candidates.length === 1 && candidates[0].dayGap === 0) {
      found.push({ transaction, candidate: candidates[0] });
    }
  }
  return found;
}

export type AutoLinkResult = {
  linked: { transactionId: string; description: string; party: string }[];
  failed: { transactionId: string; reason: string }[];
};

export async function autoLinkCompany(options: {
  companyId: string;
  limit?: number;
}): Promise<AutoLinkResult> {
  const result: AutoLinkResult = { linked: [], failed: [] };

  for (const { transaction, candidate } of await unambiguousMatches(options)) {
    try {
      await linkToPayment({
        companyId: options.companyId,
        transactionId: transaction.id,
        ...(candidate.kind === "payment"
          ? { paymentId: candidate.id }
          : { billPaymentId: candidate.id }),
        // Never true here: this only ever links a payment that already existed,
        // so unmatching must not reverse anything.
        createdByThisMatch: false,
      });
      result.linked.push({
        transactionId: transaction.id,
        description: transaction.description,
        party: candidate.party,
      });
    } catch (error) {
      // Usually a line another process claimed first — not worth failing the run.
      result.failed.push({
        transactionId: transaction.id,
        reason: error instanceof Error ? error.message : "Could not be linked",
      });
    }
  }

  if (result.linked.length > 0) {
    await writeAudit({
      companyId: options.companyId,
      action: "bank.auto_linked",
      entityType: "BankTransaction",
      entityId: result.linked[0]?.transactionId ?? null,
      summary: `${result.linked.length} bank line(s) linked automatically`,
      data: { linked: result.linked, failed: result.failed },
    });
  }

  return result;
}

/** The scheduled job: every company that has switched auto-link on. */
export async function runBankAutoLink() {
  const companies = await prisma.company.findMany({
    where: { bankAutoLinkEnabled: true },
    select: { id: true, name: true },
  });

  const runs = [];
  for (const company of companies) {
    try {
      const result = await autoLinkCompany({ companyId: company.id });
      runs.push({ company: company.name, ...result });
    } catch (error) {
      runs.push({ company: company.name, linked: [], failed: [{ transactionId: "", reason: String(error) }] });
    }
  }
  return runs;
}
