"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { type ActionResult, requestScheduleRunAction } from "@/app/schedules/actions";

/**
 * "Run now…" on the agent page. The dashboard never starts runs itself: this reuses a bound
 * schedule's run now (stamps run_requested_at; the lease holder fires it on its next tick).
 * Without a bound schedule it renders nothing. Two steps, the second names the schedule. A
 * schedule already requested is said so in words, not offered again; opening the second step
 * clears the message of the previous request.
 */
export function AgentRunNow({ schedules }: { schedules: RunNowSchedule[] }) {
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
    <AgentRunNowView
      schedules={schedules}
      open={open}
      pending={pending}
      result={result}
      onOpen={() => {
        setResult(null);
        setOpen(true);
      }}
      onCancel={() => setOpen(false)}
      onFire={fire}
    />
  );
}

type RunNowSchedule = { id: string; name: string; requested: boolean };

/** The markup of every state of AgentRunNow, which holds the state (rendered as is by the tests). */
export function AgentRunNowView({
  schedules,
  open,
  pending,
  result,
  onOpen,
  onCancel,
  onFire,
}: {
  schedules: RunNowSchedule[];
  open: boolean;
  pending: boolean;
  result: ActionResult | null;
  onOpen: () => void;
  onCancel: () => void;
  onFire: (id: string) => void;
}) {
  const allRequested = schedules.every((s) => s.requested);
  return (
    <span className="ad-run-now">
      {open ? (
        <>
          <span className="muted">Run now through</span>
          {schedules.map((s) =>
            s.requested ? (
              <span key={s.id} className="muted">
                “{s.name}” already requested, it starts on the next tick
              </span>
            ) : (
              <button
                key={s.id}
                type="button"
                className="ad-btn primary"
                disabled={pending}
                onClick={() => onFire(s.id)}
              >
                {pending ? "…" : `“${s.name}”`}
              </button>
            ),
          )}
          <button type="button" className="ad-btn" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="ad-btn primary"
          disabled={allRequested}
          onClick={onOpen}
          title={
            allRequested
              ? "Already requested: the ticking process starts it on its next tick"
              : "Fire a bound schedule once now, outside its cron: same busy rules as a tick"
          }
        >
          {allRequested ? "Run requested" : "Run now…"}
        </button>
      )}
      {result && <span className={`ad-run-msg ${result.ok ? "muted" : "bad-text"}`}>{result.message}</span>}
    </span>
  );
}
