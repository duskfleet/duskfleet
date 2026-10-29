import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { loadConfig } from "./loader.js";

/**
 * The keys of config/duskfleet.yaml the dashboard's Settings page edits, dotted. The others
 * (data_dir, user_agents_dir, user_projects_file, scheduler.default_time_zone,
 * scheduler.noop_pattern, scheduler.allow_command_gates, claude.allow_bypass_permissions,
 * claude.env_passthrough) stay hand edits of the file.
 */
export const EDITABLE_GLOBAL_KEYS = [
  "max_concurrent_runs",
  "max_concurrent_per_project",
  "max_concurrent_per_agent",
  "scheduler.tick_seconds",
  "scheduler.auto_pause_after",
  "scheduler.enabled",
  "claude.default_timeout_minutes",
  "claude.default_max_budget_usd",
  "claude.strict_mcp_config",
  "claude.setting_sources",
  "claude.binary",
  "allowed_project_roots",
  "default_agent",
] as const;

export type EditableGlobalKey = (typeof EDITABLE_GLOBAL_KEYS)[number];

export type GlobalValue = string | number | boolean | null | string[];

export interface GlobalFileInfo {
  path: string;
  /** Last modification of the file, ISO. */
  modifiedAt: string;
  /** The raw value of each editable key as written in the file (undefined = absent, the default applies). */
  values: Partial<Record<EditableGlobalKey, GlobalValue>>;
}

export function globalConfigPath(configDir: string): string {
  return path.join(configDir, "duskfleet.yaml");
}

/** Reads the editable keys as written (not resolved: `~` and relative roots stay as typed). */
export function readGlobalFile(configDir: string): GlobalFileInfo {
  const file = globalConfigPath(configDir);
  const doc = parseDocument(readFileSync(file, "utf8"));
  const values: GlobalFileInfo["values"] = {};
  for (const key of EDITABLE_GLOBAL_KEYS) {
    const v = doc.getIn(key.split("."));
    if (v === undefined) continue;
    values[key] = (
      v !== null && typeof v === "object" && "toJSON" in v ? (v as { toJSON(): unknown }).toJSON() : v
    ) as GlobalValue;
  }
  return { path: file, modifiedAt: statSync(file).mtime.toISOString(), values };
}

/**
 * Sets the given keys in config/duskfleet.yaml, keeping its comments and layout, then loads the
 * config: a change the loader refuses (or one that breaks the file) restores the previous text
 * and throws the loader's error. Returns the file's new modification time.
 */
export function writeGlobalFile(configDir: string, changes: Partial<Record<EditableGlobalKey, GlobalValue>>): string {
  const file = globalConfigPath(configDir);
  const before = readFileSync(file, "utf8");
  const doc = parseDocument(before);
  if (doc.errors.length > 0) throw new Error(`${file} does not parse: ${doc.errors[0]!.message}`);
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error(`${file} is not a YAML mapping`);
  for (const [key, value] of Object.entries(changes)) {
    if (!(EDITABLE_GLOBAL_KEYS as readonly string[]).includes(key)) throw new Error(`${key} is not editable here`);
    const current = doc.getIn(key.split("."), true);
    // Same scalar node, new value: keeps a trailing comment such as `enabled: true  # kill switch`.
    if (isScalar(current) && !Array.isArray(value)) {
      current.value = value;
      continue;
    }
    const node = doc.createNode(value);
    // A list keeps the file's style: `[project, local]` stays on one line.
    if (Array.isArray(value)) (node as { flow?: boolean }).flow = true;
    doc.setIn(key.split("."), node);
  }
  writeFileSync(file, doc.toString());
  try {
    loadConfig(configDir);
  } catch (err) {
    writeFileSync(file, before);
    throw err;
  }
  return statSync(file).mtime.toISOString();
}
