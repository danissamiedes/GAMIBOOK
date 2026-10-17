"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button } from "@/components/ui";

type Progress = { done: number; remaining: number; finished: boolean };

/** The server's own no — not worth asking twice. */
class Refused extends Error {}

/**
 * What to show when the answer was not ours: a host that kills a function
 * answers with its own page, and a wall of HTML in a red box says nothing.
 */
function readableError(body: string, status: number): string {
  const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (status === 504 || /TIMEOUT/i.test(text)) {
    return "That batch of postings took too long and the server cut it off";
  }
  if (!text || text.length > 200 || /^<|<!doctype/i.test(body.trim())) {
    return `The server answered ${status}`;
  }
  return text;
}

/**
 * Running a batch to the end, a chunk at a time (SPEC §18).
 *
 * A few hundred postings fit in neither one transaction nor one serverless
 * function, so the page asks for a chunk, is told what is left, and asks
 * again. What makes that safe is that the batch was decided in full before
 * any of it posted: this loop only works through a list that is already
 * reserved, and every line records its own entry as it goes. Stopping — a
 * closed laptop, a dropped connection — leaves a batch that says where it got
 * to, and this panel is also how it is picked back up.
 */
export function RunPanel({
  batchId,
  mode,
  planned,
  autoStart,
}: {
  batchId: string;
  mode: "post" | "reverse";
  /** How many postings are waiting when the page is drawn. */
  planned: number;
  autoStart: boolean;
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [remaining, setRemaining] = useState(planned);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(0);
  const started = useRef(false);

  const chunk = useCallback(async (): Promise<Progress> => {
    let lastMessage = "The server could not be reached";
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        setRetrying(attempt);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
      try {
        const response = await fetch(`/reclassify/${batchId}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        if (response.ok) {
          setRetrying(0);
          return (await response.json()) as Progress;
        }
        const message = readableError(await response.text(), response.status);
        // A refusal is the server's answer; anything else is the plumbing,
        // and nothing posted is ever lost by asking again.
        if (response.status < 500) throw new Refused(message);
        lastMessage = message;
      } catch (caught) {
        if (caught instanceof Refused) throw caught;
        lastMessage = caught instanceof Error ? caught.message : String(caught);
      }
    }
    throw new Error(`${lastMessage} — nothing was lost; press Continue to carry on.`);
  }, [batchId, mode]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    let total = 0;
    try {
      for (;;) {
        const progress = await chunk();
        total += progress.done;
        setCompleted(total);
        setRemaining(progress.remaining);
        if (progress.finished) break;
        // A chunk that did nothing while work remains would loop forever.
        if (progress.done === 0) break;
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
      setRetrying(0);
      router.refresh();
    }
  }, [chunk, router]);

  useEffect(() => {
    if (!autoStart || started.current) return;
    started.current = true;
    void run();
  }, [autoStart, run]);

  const verb = mode === "post" ? "Posting" : "Undoing";
  const noun = mode === "post" ? "postings moved" : "entries reversed";

  return (
    <div className="space-y-3">
      {running ? (
        <Alert tone="info">
          <strong className="block" aria-live="polite">
            {retrying > 0
              ? `Interrupted — trying again (${retrying} of 3)`
              : `${verb}… ${completed} ${noun}, ${remaining} to go`}
          </strong>
          <span className="mt-1 block text-sm">
            Leave this page open. Everything already done is recorded; if this stops, the batch can
            be picked up where it left off.
          </span>
        </Alert>
      ) : null}

      {error ? (
        <Alert tone="error">
          <strong className="block">{error}</strong>
          <span className="mt-1 block text-sm">
            {completed > 0 ? `${completed} ${noun} are recorded and will not be repeated. ` : ""}
            Nothing is lost — carry on below.
          </span>
        </Alert>
      ) : null}

      {!running ? (
        <Button type="button" onClick={run}>
          {completed > 0 || error
            ? `Continue — ${remaining} to go`
            : mode === "post"
              ? `Post ${remaining} ${remaining === 1 ? "entry" : "entries"}`
              : `Undo ${remaining} ${remaining === 1 ? "entry" : "entries"}`}
        </Button>
      ) : null}
    </div>
  );
}
