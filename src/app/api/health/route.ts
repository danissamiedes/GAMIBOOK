import { prisma } from "@/lib/db";
import { opsAuthorised } from "@/lib/ops-auth";

/**
 * What this deployment is actually running against.
 *
 * Vercel will not show a Sensitive environment variable back, so there is no
 * way from the dashboard to answer "is DATABASE_URL on 6543 or 5432?" — and
 * getting that wrong took the app down for an afternoon. This answers it from
 * inside the running deployment, which is the only place that knows.
 *
 * It also times a round trip, which is the number behind the transaction
 * timeouts: a function in one region and a database in another shows up here as
 * hundreds of milliseconds for a query that should take one.
 *
 * Credentials are never returned — the connection string is reduced to host,
 * port and the flags that matter.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Host, port and pooling flags. Never the user, never the password. */
function describeConnection(raw: string | undefined) {
  if (!raw) return { configured: false as const };
  try {
    const url = new URL(raw);
    const port = url.port || "5432";
    return {
      configured: true as const,
      host: url.hostname,
      port,
      // Supabase's pooler serves transaction mode on 6543 and session mode on
      // 5432; a non-pooler host is a direct connection.
      mode: url.hostname.includes("pooler")
        ? port === "6543"
          ? "transaction pooler"
          : "session pooler"
        : "direct",
      pgbouncer: url.searchParams.get("pgbouncer") === "true",
      connectionLimit: url.searchParams.get("connection_limit"),
    };
  } catch {
    return { configured: true as const, malformed: true as const };
  }
}

export async function GET(request: Request) {
  if (!opsAuthorised(request)) {
    return Response.json({ error: "Not authorised" }, { status: 401 });
  }

  const database = describeConnection(process.env.DATABASE_URL);
  const migrations = describeConnection(process.env.DIRECT_DATABASE_URL);

  const at = Date.now();
  let reachable = false;
  let roundTripMs: number | null = null;
  let error: string | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
    roundTripMs = Date.now() - at;
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message.split("\n").slice(-1)[0]!.trim() : String(thrown);
  }

  const warnings: string[] = [];
  if (database.configured && !("malformed" in database)) {
    if (database.mode === "session pooler") {
      warnings.push(
        "DATABASE_URL is on the session pooler. That caps the whole project at a " +
          "handful of clients and locks everyone out when reached — use the " +
          "transaction pooler on 6543 for the app.",
      );
    }
    if (database.mode === "transaction pooler" && !database.pgbouncer) {
      warnings.push("pgbouncer=true is missing; Prisma's prepared statements will fail.");
    }
    if (!database.connectionLimit) {
      warnings.push(
        "connection_limit is not set; each instance opens a pool and a few of " +
          "them will exhaust the database's client limit.",
      );
    }
  }
  if (roundTripMs !== null && roundTripMs > 150) {
    warnings.push(
      `A trivial query took ${roundTripMs}ms. The function and the database are ` +
        "probably in different regions, which is what pushes postings past the " +
        "transaction timeout.",
    );
  }

  return Response.json(
    {
      reachable,
      roundTripMs,
      error,
      region: process.env.VERCEL_REGION ?? null,
      database,
      migrations,
      storage: process.env.STORAGE_DRIVER ?? "local",
      emailDryRun: process.env.EMAIL_DRY_RUN !== "false",
      schedulerInProcess: process.env.SCHEDULER_ENABLED === "true",
      warnings,
    },
    { status: reachable ? 200 : 503 },
  );
}
