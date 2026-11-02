"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type ActionResult, requestScheduleRunAction } from "@/app/schedules/actions";

/**
 * "Run now…" on the agent page. The dashboard never starts runs itself: this reuses a bound
 * schedule's run now (stamps run_requested_at; the lease holder fires it on its next tick).
 * Without a bound schedule it renders nothing. Two steps, the second names the schedule.
 */
export function AgentRunNow({ schedules }: { schedules: Array<{ id: string; name: string; requested: boolean }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  if (schedules.length === 0) return null;

  const fire = (id: string) =>
    start(async () => {
      const r = await requestScheduleRunAction(id);
      setResult(r);
      setOpen(false);
      if (r.ok) router.refresh();
    });

  return (
    <span className="ad-run-now">
      {open ? (
        <>
          <span className="muted">Run now through</span>
          {schedules.map((s) => (
            <button
              key={s.id}
              type="button"
              className="ad-btn primary"
              disabled={pending || s.requested}
              title={s.requested ? "Already requested: the ticking process starts it on its next tick" : undefined}
              onClick={() => fire(s.id)}
            >
              {pending ? "…" : `“${s.name}”`}
            </button>
          ))}
          <button type="button" className="ad-btn" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ad-btn primary"
          onClick={() => setOpen(true)}
          title="Fire a bound schedule once now, outside its cron: same busy rules as a tick"
        >
          Run now…
        </button>
      )}
      {result && <span className={result.ok ? "muted" : "bad-text"}>{result.message}</span>}
    </span>
  );
}
