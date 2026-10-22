"use server";

import { updateSchedule } from "@duskfleet/core";
/**
 * Schedule writes from the dashboard: pause / resume, change when it fires
 * (cron + time zone), delete, and "run now". They go through the same validation
 * as the MCP tools (core's createSchedule/updateSchedule), write the same DB
 * rows, and whichever process holds the scheduler lease picks the change up on
 * its next tick. Runs and builtins are still never touched from here: "run now"
 * does not spawn Claude in the dashboard process, it sets `run_requested_at`
 * and the ticking process fires the schedule (see Scheduler.tick).
 */
import { revalidatePath } from "next/cache";
import { config, services } from "@/lib/data";

export interface ActionResult {
  ok: boolean;
  message: string;
}

function fail(err: unknown): ActionResult {
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

export async function setScheduleEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    const s = updateSchedule(services().schedules, config(), id, { enabled });
    revalidatePath("/schedules");
    return {
      ok: true,
      message: enabled
        ? `Resumed "${s.name}"${s.nextRunAt ? `, next ${new Date(s.nextRunAt).toLocaleString()}` : ""}.`
        : `Paused "${s.name}".`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function updateScheduleWhenAction(id: string, cron: string, timeZone: string): Promise<ActionResult> {
  try {
    const s = updateSchedule(services().schedules, config(), id, { cron: cron.trim(), timeZone: timeZone.trim() });
    revalidatePath("/schedules");
    return {
      ok: true,
      message: `"${s.name}" now runs on "${s.cron}" (${s.timeZone})${s.enabled && s.nextRunAt ? `, next ${new Date(s.nextRunAt).toLocaleString()}` : ""}.`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function requestScheduleRunAction(id: string): Promise<ActionResult> {
  try {
    const cfg = config();
    const repo = services().schedules;
    const s = repo.requestRun(id);
    if (!s) return { ok: false, message: "Schedule not found (already deleted?)." };
    revalidatePath("/schedules");
    const lease = repo.leaseInfo();
    const live = lease ? new Date(lease.expiresAt).getTime() > Date.now() : false;
    if (!cfg.scheduler.enabled) {
      return {
        ok: true,
        message: `Run of "${s.name}" requested, but scheduler.enabled is false: nothing fires until the kill switch is off.`,
      };
    }
    if (!live) {
      return {
        ok: true,
        message: `Run of "${s.name}" requested; it starts as soon as a Duskfleet process ticks (duskfleet serve or the MCP server).`,
      };
    }
    return {
      ok: true,
      message: `Run of "${s.name}" requested; the ticking process starts it within ${cfg.scheduler.tickSeconds} s (busy agent or project = skipped).`,
    };
  } catch (err) {
    return fail(err);
  }
}

export async function deleteScheduleAction(id: string): Promise<ActionResult> {
  try {
    const repo = services().schedules;
    const s = repo.get(id);
    if (!s) return { ok: false, message: "Schedule not found (already deleted?)." };
    repo.delete(id);
    revalidatePath("/schedules");
    return { ok: true, message: `Deleted "${s.name}". Its past runs keep their scheduleId.` };
  } catch (err) {
    return fail(err);
  }
}
