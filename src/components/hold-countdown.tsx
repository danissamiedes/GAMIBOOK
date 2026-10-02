"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * How long is left to pay (SPEC §17).
 *
 * The hold is already enforced on the server — the grid frees the slots, the
 * upload is refused, a sweep cancels the row — so this clock decides nothing.
 * It only tells the person what is about to happen, which is the difference
 * between a page that quietly stops working and one that warned them.
 *
 * The remaining seconds come from the server rather than a deadline the browser
 * subtracts from its own clock: a device whose time is ten minutes out would
 * otherwise show a countdown that disagrees with the booking. From there the
 * deadline is pinned at mount and read off the monotonic difference, so a tab
 * left in the background for a minute comes back a minute shorter rather than
 * one tick shorter.
 */
export function HoldCountdown({
  seconds,
  returnTo,
}: {
  /** Seconds left when the page was rendered. */
  seconds: number;
  /** Where to send the booker once it runs out. */
  returnTo: string;
}) {
  const router = useRouter();
  const [left, setLeft] = useState(Math.max(0, seconds));

  useEffect(() => {
    // The deadline is pinned once, here rather than during render: reading the
    // clock while rendering is impure, and a re-render would move the finish
    // line.
    const endsAt = Date.now() + Math.max(0, seconds) * 1000;
    const tick = () => {
      const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      setLeft(remaining);
      // Back to the schedule, with the slots already on the market again. A
      // replace rather than a push, so the back button does not return to a
      // page offering to take payment for somebody else's court.
      if (remaining === 0) router.replace(returnTo);
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [router, returnTo, seconds]);

  const minutes = Math.floor(left / 60);
  const urgent = left <= 120;

  return (
    <div
      className={`mt-4 flex items-baseline justify-between gap-3 rounded-lg border px-3 py-2 ${
        urgent
          ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
          : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200"
      }`}
      // A timer a screen reader can read on demand, but never announces on its
      // own: sixty interruptions a minute would drown out the page the clock is
      // telling them to act on.
      role="timer"
      aria-live="off"
    >
      <span className="text-sm font-medium">Time left to pay</span>
      <span className="font-mono text-xl font-bold tabular-nums" suppressHydrationWarning>
        {minutes}:{String(left % 60).padStart(2, "0")}
      </span>
    </div>
  );
}
