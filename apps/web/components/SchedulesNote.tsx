/**
 * Schedules page header note: where a schedule is created and changed. Keep in sync with docs/schedules.md:
 * creating is MCP only, the dashboard edits, the CLI lists and fires (`runNowCmd`, the install's own form).
 */
export function SchedulesNote({ runNowCmd }: { runNowCmd: string }) {
  return (
    <span className="note">
      Created over MCP (<code>create_schedule</code>). Pause, resume, cron and time zone, delete and run now here; the
      CLI fires one with <code>{runNowCmd}</code>.
    </span>
  );
}
