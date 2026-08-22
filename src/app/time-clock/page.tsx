import { pageTitle } from "@/lib/brand";
import { redirect } from "next/navigation";
import { currentUserId, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { resolveActiveCompanyId } from "@/lib/active-company";
import { withCompanyScope } from "@/lib/company-scope";
import {
  ClockError,
  clockIn,
  clockOut,
  consultantForUser,
  openEntryFor,
  requestCorrection,
} from "@/lib/time/clock";
import { entriesForConsultant } from "@/lib/time/report";
import {
  formatDayLabel,
  formatDuration,
  formatTimeInZone,
  minutesBetween,
  weekBounds,
  workDayKey,
  zoneAbbreviation,
} from "@/lib/time/zone";
import { LiveClock, ElapsedSince } from "@/components/live-clock";
import { Alert, Button, Card, EmptyState, Input } from "@/components/ui";

export const metadata = { title: pageTitle("Time clock") };

/**
 * The consultant's only screen (SPEC §2, §9). Big buttons, one decision at a
 * time, readable on a phone. Every time on this page is in the company's
 * time-clock zone with the zone named, for every viewer.
 */
export default async function TimeClockPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const userId = await currentUserId();
  if (!userId) redirect("/login");
  const params = await searchParams;

  const companyId = await resolveActiveCompanyId(userId);
  if (!companyId) redirect("/no-access");
  await withCompanyScope(userId, companyId);

  const company = await prisma.company.findFirstOrThrow({ where: { id: companyId } });
  const zone = company.timeClockTimeZone;
  const consultant = await consultantForUser(userId, companyId);

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  if (!consultant) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Time clock</h1>
          <form action={endSession}>
            <Button variant="ghost" type="submit">
              Sign out
            </Button>
          </form>
        </div>
        <Card>
          <Alert tone="warning">
            Your account is not linked to a consultant record in {company.name}, so there is nothing
            to clock in to. Ask an owner to link it.
          </Alert>
        </Card>
      </main>
    );
  }

  const now = new Date();
  const label = zoneAbbreviation(now, zone);
  const open = await openEntryFor(consultant.id);

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const recent = await entriesForConsultant({
    companyId,
    consultantId: consultant.id,
    since: thirtyDaysAgo,
  });

  const todayKey = workDayKey(now, zone);
  const todays = recent.filter((entry) => workDayKey(entry.clockInAt, zone) === todayKey);
  const week = weekBounds(now, zone);
  const weekMinutes = recent
    .filter((entry) => week.dayKeys.includes(workDayKey(entry.clockInAt, zone)))
    .reduce(
      (total, entry) =>
        total + (entry.clockOutAt ? (entry.durationMinutes ?? minutesBetween(entry.clockInAt, entry.clockOutAt)) : 0),
      0,
    );

  async function punch(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    if (!uid) redirect("/login");
    const cid = await resolveActiveCompanyId(uid);
    if (!cid) redirect("/no-access");
    const me = await consultantForUser(uid, cid);
    if (!me) redirect("/time-clock");

    const note = String(formData.get("note") || "").trim() || null;
    try {
      if (String(formData.get("intent")) === "in") {
        await clockIn({ companyId: cid, consultantId: me.id, note });
      } else {
        await clockOut({ companyId: cid, consultantId: me.id, note });
      }
    } catch (error) {
      if (error instanceof ClockError) {
        redirect(`/time-clock?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect("/time-clock");
  }

  async function flag(formData: FormData) {
    "use server";
    const uid = await currentUserId();
    if (!uid) redirect("/login");
    const cid = await resolveActiveCompanyId(uid);
    if (!cid) redirect("/no-access");
    const me = await consultantForUser(uid, cid);
    if (!me) redirect("/time-clock");

    try {
      await requestCorrection({
        companyId: cid,
        consultantId: me.id,
        entryId: String(formData.get("entryId")),
        message: String(formData.get("message") || ""),
      });
    } catch (error) {
      if (error instanceof ClockError) {
        redirect(`/time-clock?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect("/time-clock?saved=1");
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{consultant.name}</h1>
          <p className="text-xs text-slate-500">{company.name}</p>
        </div>
        <form action={endSession}>
          <Button variant="ghost" type="submit">
            Sign out
          </Button>
        </form>
      </div>

      {params.error ? <Alert tone="error">{params.error}</Alert> : null}
      {params.saved ? (
        <Alert tone="success">Sent. An admin will look at that entry.</Alert>
      ) : null}

      <Card className="mt-4">
        <LiveClock timeZone={zone} label={label} />

        <div className="mt-6">
          {open ? (
            <>
              <ElapsedSince
                startedAtIso={open.clockInAt.toISOString()}
                startedLabel={`${formatTimeInZone(open.clockInAt, zone)} ${label}`}
              />
              <form action={punch} className="mt-4 space-y-3">
                <input type="hidden" name="intent" value="out" />
                <Input name="note" placeholder="What did you work on? (optional)" defaultValue={open.note ?? ""} />
                <Button type="submit" variant="danger" className="h-14 w-full text-base">
                  Clock out
                </Button>
              </form>
            </>
          ) : (
            <form action={punch} className="space-y-3">
              <input type="hidden" name="intent" value="in" />
              <p className="text-center text-sm text-slate-500">Not clocked in</p>
              <Input name="note" placeholder="What are you working on? (optional)" />
              <Button type="submit" className="h-14 w-full text-base">
                Clock in
              </Button>
            </form>
          )}
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">Today</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {formatDuration(
              todays.reduce(
                (total, entry) =>
                  total +
                  (entry.clockOutAt
                    ? (entry.durationMinutes ?? minutesBetween(entry.clockInAt, entry.clockOutAt))
                    : 0),
                0,
              ),
            )}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-slate-500">This week</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatDuration(weekMinutes)}</p>
        </Card>
      </div>

      <h2 className="mt-8 mb-2 text-sm font-semibold">Your last 30 days</h2>
      <p className="mb-3 text-xs text-slate-500">
        Read-only. If something is wrong, add a note and an admin will correct it.
      </p>

      {recent.length === 0 ? (
        <EmptyState title="Nothing recorded yet" />
      ) : (
        <div className="space-y-2">
          {recent.map((entry) => (
            <Card key={entry.id} className="p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {formatDayLabel(workDayKey(entry.clockInAt, zone), zone)}
                </span>
                <span className="text-sm tabular-nums">
                  {entry.clockOutAt
                    ? formatDuration(
                        entry.durationMinutes ?? minutesBetween(entry.clockInAt, entry.clockOutAt),
                      )
                    : "running"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">
                {formatTimeInZone(entry.clockInAt, zone)} –{" "}
                {entry.clockOutAt ? formatTimeInZone(entry.clockOutAt, zone) : "…"} {label}
                {entry.source !== "SELF" ? ` · ${entry.source.toLowerCase().replace(/_/g, " ")}` : ""}
              </p>
              {entry.note ? <p className="mt-1 text-sm">{entry.note}</p> : null}

              {entry.correctionRequest ? (
                <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
                  {entry.correctionResolvedAt ? "Resolved: " : "Awaiting review: "}
                  {entry.correctionRequest}
                </p>
              ) : (
                <form action={flag} className="mt-2 flex gap-2">
                  <input type="hidden" name="entryId" value={entry.id} />
                  <Input name="message" placeholder="Request a correction" className="text-sm" />
                  <Button variant="secondary" type="submit">
                    Send
                  </Button>
                </form>
              )}
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
