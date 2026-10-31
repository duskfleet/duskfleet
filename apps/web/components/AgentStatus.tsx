import type { AgentState } from "@/lib/agents";

const LABEL: Record<AgentState, string> = {
  running: "running",
  paused: "paused · auto",
  review: "needs review",
  idle: "idle",
};

const CLASS: Record<AgentState, string> = {
  running: "running",
  paused: "paused-auto",
  review: "attention",
  idle: "pending",
};

const TITLE: Record<AgentState, string> = {
  running: "A run of this agent is in progress",
  paused: "A schedule of this agent was paused by the scheduler (scheduler.auto_pause_after); resume it in Schedules",
  review: "The last finished run needs review (its stored review reasons)",
  idle: "No run in progress; the last finished run is clean",
};

/** The DS-21 status pill: run tints like the run badges; a pause is an outline, not a failure. */
export function AgentStatus({ state }: { state: AgentState }) {
  return (
    <span className={`badge ${CLASS[state]}`} title={TITLE[state]}>
      {LABEL[state]}
    </span>
  );
}
