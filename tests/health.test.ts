import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { prisma } from "@/lib/db";

/**
 * Vercel will not show a Sensitive environment variable back, so the only place
 * that can say what a deployment is really connected to is the deployment. This
 * endpoint exists because not knowing that cost an afternoon of downtime — so
 * what it reports has to be right, and it must never report the password.
 */
const SECRET = "a-test-cron-secret";

function request(headers: Record<string, string> = { "x-cron-key": SECRET }) {
  return new Request("https://books.example.com/api/health", { headers });
}

const POOLER = "aws-1-ap-southeast-1.pooler.supabase.com";

describe("health endpoint", () => {
  const saved = { ...process.env };

  /**
   * Connect before any test rewrites DATABASE_URL. Prisma connects lazily, so
   * without this the pool would be opened against whichever fake host the
   * previous case happened to set, and the reachability check would fail for a
   * reason that has nothing to do with the endpoint.
   */
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("refuses without the secret, like the cron endpoint", async () => {
    expect((await GET(request({}))).status).toBe(401);
    expect((await GET(request({ "x-cron-key": "wrong" }))).status).toBe(401);
  });

  it("never returns the password, whatever the connection string holds", async () => {
    process.env.DATABASE_URL = `postgresql://postgres.abc:sup3r-s3cret@${POOLER}:6543/postgres?pgbouncer=true`;
    const body = JSON.stringify(await (await GET(request())).json());
    expect(body).not.toContain("sup3r-s3cret");
    expect(body).not.toContain("postgres.abc");
    expect(body).toContain(POOLER);
  });

  it("names the pooling mode from the port", async () => {
    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:6543/postgres`;
    expect((await (await GET(request())).json()).database.mode).toBe("transaction pooler");

    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:5432/postgres`;
    expect((await (await GET(request())).json()).database.mode).toBe("session pooler");

    process.env.DATABASE_URL = "postgresql://u:p@db.abc.supabase.co:5432/postgres";
    expect((await (await GET(request())).json()).database.mode).toBe("direct");
  });

  /** The three misconfigurations that actually happened, each called out by name. */
  it("warns about the session pooler, which locked the app out", async () => {
    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:5432/postgres?connection_limit=1`;
    const body = await (await GET(request())).json();
    expect(body.warnings.join(" ")).toMatch(/session pooler/i);
  });

  it("warns when pgbouncer=true is missing on the transaction pooler", async () => {
    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:6543/postgres?connection_limit=1`;
    const body = await (await GET(request())).json();
    expect(body.warnings.join(" ")).toMatch(/pgbouncer/i);
  });

  it("warns when connection_limit is unset, which is what exhausts the pool", async () => {
    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:6543/postgres?pgbouncer=true`;
    const body = await (await GET(request())).json();
    expect(body.warnings.join(" ")).toMatch(/connection_limit/i);
  });

  it("is quiet when the connection is configured the way it should be", async () => {
    process.env.DATABASE_URL = `postgresql://u:p@${POOLER}:6543/postgres?pgbouncer=true&connection_limit=1`;
    const body = await (await GET(request())).json();
    expect(body.warnings.filter((w: string) => !/took \d+ms/.test(w))).toEqual([]);
  });

  it("says whether the database answered, and how long it took", async () => {
    const body = await (await GET(request())).json();
    expect(body.reachable).toBe(true);
    expect(typeof body.roundTripMs).toBe("number");
  });

  it("does not fall over on a malformed connection string", async () => {
    process.env.DATABASE_URL = "not a url";
    const body = await (await GET(request())).json();
    expect(body.database).toMatchObject({ configured: true, malformed: true });
  });
});
