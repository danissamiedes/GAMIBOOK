import { describe, expect, it } from "vitest";
// The app's client, not the one in helpers.ts: helpers constructs a bare
// PrismaClient, so testing through it would measure Prisma's default rather
// than the ceiling db.ts configures — which is the whole point here.
import { prisma } from "@/lib/db";

/**
 * Prisma's default interactive-transaction timeout is 5 seconds, and a posting
 * from a serverless function to a database in another region can exceed it:
 * every query is a round trip, and a bill payment makes a couple of dozen. That
 * is P2028 — the transaction is killed, nothing is saved, and the ledger is
 * untouched but the user is told only "something went wrong".
 *
 * db.ts raises the ceiling to 20s. This holds it there, by running a
 * transaction that the default would have killed.
 */
describe("interactive transaction ceiling", () => {
  it("allows a transaction longer than Prisma's five-second default", async () => {
    const started = Date.now();
    const result = await prisma.$transaction(async (tx) => {
      // Six seconds of database-side waiting, as a stand-in for the round trips
      // a cross-region posting spends on the network.
      // ::text because pg_sleep returns void, which Prisma cannot deserialise.
      await tx.$queryRaw`SELECT pg_sleep(6)::text`;
      return "committed";
    });

    expect(result).toBe("committed");
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
  }, 30_000);

  /**
   * There is deliberately no test that the ceiling still *bites*. Proving it
   * means sleeping past 20 seconds, and a 25-second test on every run is a poor
   * trade for guarding a constant that is read one line above. The value that
   * matters — that six seconds no longer dies — is covered.
   */
});
