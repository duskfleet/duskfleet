"use server";

/**
 * Settings writes from the dashboard: the editable keys of config/duskfleet.yaml, through
 * core's writeGlobalFile (comments kept, the change rolled back when the loader refuses it).
 * Every process re-reads the file on its next run or tick, so nothing is restarted here.
 * The scheduler kill switch has its own action: no section save can change it.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EDITABLE_GLOBAL_KEYS, type EditableGlobalKey, type GlobalValue, writeGlobalFile } from "@duskfleet/core";
import { revalidatePath } from "next/cache";
import { config, services } from "@/lib/data";
import { SETTINGS_MARKER } from "@/lib/settings";

export interface SettingsResult {
  ok: boolean;
  message: string;
  /** ISO time of the write, for "Saved · HH:MM". */
  savedAt?: string;
}

function write(changes: Partial<Record<EditableGlobalKey, GlobalValue>>): SettingsResult {
  const modifiedAt = writeGlobalFile(services().configDir, changes);
  try {
    // The file's mtime after our own write: another mtime on the page = a hand edit.
    writeFileSync(path.join(config().dataDir, SETTINGS_MARKER), `${JSON.stringify({ modifiedAt })}\n`);
  } catch {
    // Only the source line's "outside the dashboard" depends on it.
  }
  revalidatePath("/", "layout");
  return { ok: true, message: "Saved to config/duskfleet.yaml.", savedAt: new Date().toISOString() };
}

export async function saveSettingsAction(
  changes: Array<{ key: EditableGlobalKey; value: GlobalValue }>,
): Promise<SettingsResult> {
  try {
    const patch: Partial<Record<EditableGlobalKey, GlobalValue>> = {};
    for (const { key, value } of changes) {
      if (!(EDITABLE_GLOBAL_KEYS as readonly string[]).includes(key)) throw new Error(`${key} is not editable here`);
      if (key === "scheduler.enabled") throw new Error("The scheduler kill switch has its own confirmation.");
      patch[key] = value;
    }
    if (Object.keys(patch).length === 0) return { ok: false, message: "Nothing to save." };
    return write(patch);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function setSchedulerEnabledAction(enabled: boolean): Promise<SettingsResult> {
  try {
    const result = write({ "scheduler.enabled": enabled });
    return {
      ...result,
      message: enabled ? "Scheduler on: schedules fire from the next tick." : "Scheduler off: no schedule fires.",
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
