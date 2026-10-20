"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  type ActionResult,
  deleteScheduleAction,
  requestScheduleRunAction,
  setScheduleEnabledAction,
  updateScheduleWhenAction,
} from "@/app/schedules/actions";

/**
 * Inline controls for one schedule: run now (a request the ticking process
 * fires on its next tick, paused or not), pause / resume, edit when it fires
 * (cron + time zone, validated server-side by the same code as update_schedule)
 * and delete with a two-step confirmation. No browser dialogs; the result is
 * shown in place.
 */
export function ScheduleActions({
  id,
  name,
  enabled,
  cron,
  timeZone,
  runRequested,
}: {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timeZone: string;
  /** A "run now" is already waiting for the next tick. */
  runRequested: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "edit" | "confirm-delete">("idle");
  const [draftCron, setDraftCron] = useState(cron);
  const [draftTz, setDraftTz] = useState(timeZone);
  const [result, setResult] = useState<ActionResult | null>(null);

  const apply = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        setMode("idle");
        router.refresh();
      }
    });

  if (mode === "edit") {
    return (
      <form
        className="sched-edit"
        onSubmit={(e) => {
          e.preventDefault();
          apply(() => updateScheduleWhenAction(id, draftCron, draftTz));
        }}
      >
        <label>
          <span className="l">cron</span>
          <input
            className="mono"
            value={draftCron}
            onChange={(e) => setDraftCron(e.target.value)}
            placeholder="0 8-20 * * 1-5"
            spellCheck={false}
            autoFocus
          />
        </label>
        <label>
          <span className="l">time zone</span>
          <input
            className="mono"
            value={draftTz}
            onChange={(e) => setDraftTz(e.target.value)}
            placeholder="Europe/London"
            spellCheck={false}
            list="duskfleet-timezones"
          />
        </label>
        <datalist id="duskfleet-timezones">
          {TIME_ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <span className="row">
          <button
            type="submit"
            className="copy-btn"
            disabled={pending || (draftCron.trim() === cron && draftTz.trim() === timeZone)}
          >
            {pending ? "…" : "Save"}
          </button>
          <button
            type="button"
            className="copy-btn"
            disabled={pending}
            onClick={() => {
              setMode("idle");
              setDraftCron(cron);
              setDraftTz(timeZone);
              setResult(null);
            }}
          >
            Cancel
          </button>
        </span>
        {result && !result.ok && <span className="err">{result.message}</span>}
        <span className="hint">
          5 fields: minute hour day-of-month month day-of-week. Resuming or editing recomputes the next tick from now.
        </span>
      </form>
    );
  }

  return (
    <span className="sched-actions">
      {mode === "confirm-delete" ? (
        <>
          <span className="muted">Delete &quot;{name}&quot;?</span>
          <button
            type="button"
            className="copy-btn danger"
            disabled={pending}
            onClick={() => apply(() => deleteScheduleAction(id))}
          >
            {pending ? "…" : "Yes, delete"}
          </button>
          <button type="button" className="copy-btn" disabled={pending} onClick={() => setMode("idle")}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="copy-btn"
            disabled={pending || runRequested}
            title={
              runRequested
                ? "Already requested: the ticking process starts it on its next tick"
                : "Fire once now, outside the cron and even when paused. Same busy rules as a tick; it starts on the next tick of the process that holds the lease."
            }
            onClick={() => apply(() => requestScheduleRunAction(id))}
          >
            {pending ? "…" : runRequested ? "Run requested" : "Run now"}
          </button>
          <button
            type="button"
            className="copy-btn"
            disabled={pending}
            title={enabled ? "Pause: nothing fires until resumed" : "Resume: the next tick is computed from now"}
            onClick={() => apply(() => setScheduleEnabledAction(id, !enabled))}
          >
            {pending ? "…" : enabled ? "Pause" : "Resume"}
          </button>
          <button
            type="button"
            className="copy-btn"
            disabled={pending}
            title="Change the cron expression or the time zone"
            onClick={() => setMode("edit")}
          >
            Edit when
          </button>
          <button
            type="button"
            className="copy-btn danger"
            disabled={pending}
            title="Remove the schedule; past runs are kept"
            onClick={() => setMode("confirm-delete")}
          >
            Delete
          </button>
        </>
      )}
      {result && <span className={result.ok ? "muted" : "err"}>{result.message}</span>}
    </span>
  );
}

const TIME_ZONES = [
  "Europe/London",
  "Europe/Rome",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Australia/Sydney",
];
