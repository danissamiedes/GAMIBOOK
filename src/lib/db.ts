import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Interactive transaction limits.
 *
 * Prisma's default is 5 seconds, which assumes the database is close. Every
 * query inside a transaction is a round trip, and a posting makes a couple of
 * dozen — so a serverless function in one region talking to a database in
 * another spends most of its transaction waiting on the network. A bill payment
 * from a US function to a Singapore database measured 5,153 ms and was killed
 * at 5,000: P2028, nothing saved, and no clue on the screen as to why.
 *
 * Raising the ceiling is the safety margin, not the fix — the fix is to run the
 * functions in the database's region, which brings the same posting under a
 * second (see "Function region" in README.md). This keeps a slow or distant
 * database from silently losing a posting in the meantime.
 *
 * 20s sits under the 60s maxDuration the app segment declares, so the
 * transaction hits its own timeout and rolls back cleanly rather than the
 * function being killed mid-write.
 */
const TRANSACTION_OPTIONS = {
  /** How long the whole interactive transaction may run. */
  timeout: 20_000,
  /** How long to wait for a connection from the pool before giving up. */
  maxWait: 10_000,
} as const;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    transactionOptions: TRANSACTION_OPTIONS,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
