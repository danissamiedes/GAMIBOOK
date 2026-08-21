import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/cron/route";
import { JOBS } from "@/lib/scheduler";
import { resetDatabase } from "./helpers";

/**
 * The cron endpoint is reachable without a session — it has to be, since a
 * scheduler has no session — so CRON_SECRET is the only thing between a
 * stranger and the job runner. That guard is what these test.
 */
const SECRET = "a-test-cron-secret";

function request(headers: Record<string, string> = {}, path = "/api/cron") {
  return new Request(`https://books.example.com${path}`, { headers });
}

describe("cron endpoint", () => {
  let original: string | undefined;

  beforeEach(async () => {
    original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    await resetDatabase();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("refuses a request with no credentials", async () => {
    expect((await GET(request())).status).toBe(401);
  });

  it("refuses a wrong secret, whichever header it arrives in", async () => {
    expect((await GET(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await GET(request({ "x-cron-key": "wrong" }))).status).toBe(401);
  });

  it("refuses everything when CRON_SECRET is not configured, rather than running open", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request({ authorization: "Bearer anything" }))).status).toBe(401);
    // An empty offered secret must not match an empty configured one either.
    process.env.CRON_SECRET = "";
    expect((await GET(request({ "x-cron-key": "" }))).status).toBe(401);
  });

  it("will not take the secret from the query string, where logs would keep it", async () => {
    const response = await GET(request({}, `/api/cron?key=${SECRET}`));
    expect(response.status).toBe(401);
  });

  it("runs every job for a correct secret and reports each one", async () => {
    const response = await GET(request({ authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(200);

    // Every registered job, not a list that quietly falls behind the scheduler.
    const body = await response.json();
    expect(body.results.map((r: { job: string }) => r.job)).toEqual(JOBS.map((j) => j.name));
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("accepts the x-cron-key header, for pingers that cannot set Authorization", async () => {
    expect((await POST(request({ "x-cron-key": SECRET }))).status).toBe(200);
  });

  it("runs one named job when asked, and 404s on a name it does not have", async () => {
    const one = await GET(request({ "x-cron-key": SECRET }, "/api/cron?job=recurring-invoices"));
    expect(one.status).toBe(200);
    expect((await one.json()).results).toHaveLength(1);

    const missing = await GET(request({ "x-cron-key": SECRET }, "/api/cron?job=nope"));
    expect(missing.status).toBe(404);
  });
});
