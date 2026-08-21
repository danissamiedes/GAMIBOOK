"use client";

import { useEffect, useState } from "react";

/**
 * The big current time, and the live-ticking elapsed counter (SPEC §9).
 * Rendered client-side because it moves, but the *zone* comes from the server —
 * the browser's own locale never decides what a consultant sees.
 */
export function LiveClock({ timeZone, label }: { timeZone: string; label: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const time = now
    ? new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }).format(now)
    : "—";

  const date = now
    ? new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(now)
    : "";

  return (
    <div className="text-center">
      <p className="text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl">{time}</p>
      <p className="mt-1 text-sm text-slate-500">
        {date} · {label}
      </p>
    </div>
  );
}

/** "Clocked in since 9:02 AM PHT — 3h 24m elapsed", ticking. */
export function ElapsedSince({
  startedAtIso,
  startedLabel,
}: {
  startedAtIso: string;
  startedLabel: string;
}) {
  const [elapsed, setElapsed] = useState<string>("");

  useEffect(() => {
    const tick = () => {
      const minutes = Math.floor((Date.now() - new Date(startedAtIso).getTime()) / 60_000);
      const safe = Math.max(0, minutes);
      setElapsed(`${Math.floor(safe / 60)}h ${String(safe % 60).padStart(2, "0")}m`);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [startedAtIso]);

  return (
    <p className="text-center text-base">
      Clocked in since <strong>{startedLabel}</strong>
      {elapsed ? <> — {elapsed} elapsed</> : null}
    </p>
  );
}
