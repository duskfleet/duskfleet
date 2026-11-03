/**
 * `duskfleet mcp register` / `duskfleet mcp status`: add the Duskfleet MCP server to a Claude
 * host, showing the exact change first.
 *
 *   claude-code     `claude mcp add --scope user ...` (printed before it runs); status reads
 *                   the user-scope `mcpServers` of `~/.claude.json`
 *   claude-desktop  `mcpServers.duskfleet` of claude_desktop_config.json: a unified diff of the
 *                   entry, a `.bak-<timestamp>` copy of the file, then the write. A file that is
 *                   not valid JSON is never overwritten.
 *
 * The entry itself (node + dist/index.js, or the pinned npx form) is rendered by core's
 * `config/mcp-entry.ts`, shared with the dashboard's /mcp page.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { claudeCodeAddArgs, desktopConfigPath, type McpServerEntry, SERVER_NAME, shellLine } from "@duskfleet/core";

export {
  claudeCodeAddArgs,
  desktopConfigPath,
  inNpxCache,
  type McpServerEntry,
  SERVER_NAME,
  type ServerEntryInput,
  serverEntry,
  shellLine,
} from "@duskfleet/core";

export const MCP_TARGETS = ["claude-code", "claude-desktop"] as const;
export type McpTarget = (typeof MCP_TARGETS)[number];

// ---- Claude Desktop -------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read a JSON object file. Missing = null. Anything that does not parse to an object throws:
 * the caller must never write over a file it could not read.
 */
export function readJsonObject(file: string): JsonObject | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); nothing was changed. Fix or move the file, then run the command again.`,
    );
  }
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object; nothing was changed.`);
  return parsed;
}

/** Minimal unified-style line diff (longest common subsequence); fine for a few dozen lines. */
export function lineDiff(before: string[], after: string[]): string[] {
  const n = before.length;
  const m = after.length;
  // lcs(i, j) = length of the longest common subsequence of before[i..] and after[j..].
  const table = new Array<number>((n + 1) * (m + 1)).fill(0);
  const lcs = (i: number, j: number) => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = before[i] === after[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push(` ${before[i]}`);
      i++;
      j++;
    } else if (lcs(i + 1, j) >= lcs(i, j + 1)) {
      out.push(`-${before[i++]}`);
    } else {
      out.push(`+${after[j++]}`);
    }
  }
  while (i < n) out.push(`-${before[i++]}`);
  while (j < m) out.push(`+${after[j++]}`);
  return out;
}

function entryLines(entry: unknown): string[] {
  if (entry === undefined) return [];
  return `"${SERVER_NAME}": ${JSON.stringify(entry, null, 2)}`.split("\n");
}

export interface DesktopPlan {
  path: string;
  /** The file exists today (it gets a backup before the write). */
  exists: boolean;
  /** The entry differs from what is there (false = already registered as is). */
  changed: boolean;
  /** Entry found in the file, if any. */
  current: unknown;
  /** Unified diff of the `mcpServers.duskfleet` entry. */
  diff: string;
  /** Full new content of the file. */
  content: string;
  /** The entry to register, kept to rebuild the content if the file changes before the write. */
  entry: McpServerEntry;
  /** Raw text the plan was built from (null: the file did not exist). */
  source: string | null;
}

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** What `register --target claude-desktop` would change. Reads only; throws on a malformed file. */
export function planDesktop(file: string, entry: McpServerEntry): DesktopPlan {
  const source = readText(file);
  const before = readJsonObject(file);
  const servers = before?.["mcpServers"];
  if (servers !== undefined && !isObject(servers)) {
    throw new Error(`${file}: "mcpServers" is not an object; nothing was changed.`);
  }
  const current = servers?.[SERVER_NAME];
  const after = { ...(before ?? {}), mcpServers: { ...(servers ?? {}), [SERVER_NAME]: entry } };
  const changed = JSON.stringify(current) !== JSON.stringify(entry);
  const diff = [
    `--- ${file}${before ? "" : " (does not exist yet)"}`,
    `+++ ${file}`,
    `@@ mcpServers.${SERVER_NAME} @@`,
    ...lineDiff(entryLines(current), entryLines(entry)),
  ].join("\n");
  return {
    path: file,
    exists: before !== null,
    changed,
    current,
    diff,
    content: `${JSON.stringify(after, null, 2)}\n`,
    entry,
    source,
  };
}

/** `claude_desktop_config.json.bak-2026-10-26T10-00-00-000Z` (no colons: valid on Windows too). */
export function backupPath(file: string, now = new Date()): string {
  return `${file}.bak-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Back the file up (when it exists), then write the plan. Nothing is written when unchanged.
 * The file may have changed while the confirmation prompt was open (Claude Desktop or the user
 * editing another key): then the content is rebuilt from the file as it is now, so that edit is
 * kept, and a file that no longer parses is refused.
 */
export function applyDesktop(previewed: DesktopPlan, now = new Date()): { written: boolean; backup: string | null } {
  if (!previewed.changed) return { written: false, backup: null };
  const plan = readText(previewed.path) === previewed.source ? previewed : planDesktop(previewed.path, previewed.entry);
  if (!plan.changed) return { written: false, backup: null };
  let backup: string | null = null;
  if (plan.exists) {
    backup = backupPath(plan.path, now);
    copyFileSync(plan.path, backup);
  } else {
    mkdirSync(path.dirname(plan.path), { recursive: true });
  }
  writeAtomically(plan.path, plan.content);
  return { written: true, backup };
}

/**
 * Replace `file` through a tmp file and a rename, without changing what the file is: a symlinked
 * config (dotfiles manager) keeps its link and the target is replaced, the original mode is kept
 * (a 600 config holding other servers' tokens stays 600) and the tmp file never outlives a failure.
 */
export function writeAtomically(file: string, content: string): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : null;
  const tmp = `${target}.duskfleet-tmp`;
  rmSync(tmp, { force: true });
  let renamed = false;
  try {
    // Created owner-only, so the content is never readable by others before the chmod.
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) rmSync(tmp, { force: true });
  }
}

// ---- Claude Code ----------------------------------------------------------------

/** Where Claude Code keeps user-scope MCP servers (`claude mcp add --scope user`). */
export function claudeCodeConfigPath(home = homedir()): string {
  return path.join(home, ".claude.json");
}

export interface McpTargetStatus {
  target: McpTarget;
  configPath: string;
  registered: boolean;
  command: string | null;
  args: string[];
  /** Environment of the entry (string values only). */
  env: Record<string, string>;
  /** Set when the config could not be read (left untouched). */
  error: string | null;
}

function stringRecord(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Same env, whatever the key order. */
function sameEnv(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] === a[k]);
}

function statusFrom(target: McpTarget, file: string): McpTargetStatus {
  const base = { target, configPath: file, registered: false, command: null, args: [], env: {}, error: null };
  try {
    const servers = readJsonObject(file)?.["mcpServers"];
    const entry = isObject(servers) ? servers[SERVER_NAME] : undefined;
    if (!isObject(entry)) return base;
    return {
      ...base,
      registered: true,
      command: typeof entry["command"] === "string" ? entry["command"] : null,
      args: Array.isArray(entry["args"]) ? entry["args"].map(String) : [],
      env: stringRecord(entry["env"]),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `mcp status`: whether each host has a `duskfleet` entry and what it runs. Read-only. */
export function mcpStatus(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): McpTargetStatus[] {
  return [
    statusFrom("claude-code", claudeCodeConfigPath(home)),
    statusFrom("claude-desktop", desktopConfigPath(platform, home, env)),
  ];
}

export interface ClaudeCodePlan {
  /** What the preview prints. */
  display: string;
  args: string[];
  /** Already registered with the same command, args and env: nothing to run. */
  upToDate: boolean;
  /**
   * Registered with something else (a missing or stale CLAUDE_BIN counts): `claude mcp add`
   * would refuse, the user removes it first.
   */
  conflict: McpTargetStatus | null;
}

export function planClaudeCode(entry: McpServerEntry, home = homedir()): ClaudeCodePlan {
  const args = claudeCodeAddArgs(entry);
  const status = statusFrom("claude-code", claudeCodeConfigPath(home));
  const same =
    status.registered &&
    status.command === entry.command &&
    JSON.stringify(status.args) === JSON.stringify(entry.args) &&
    sameEnv(status.env, entry.env);
  return {
    display: shellLine("claude", args),
    args,
    upToDate: same,
    conflict: status.registered && !same ? status : null,
  };
}

/** Run `claude mcp add`, its output on this terminal. Returns the exit status. */
export function runClaudeCodeAdd(claudeBin: string, args: string[]): number {
  const r = spawnSync(claudeBin, args, { stdio: "inherit", windowsHide: true });
  if (r.error) throw new Error(`could not run ${claudeBin}: ${r.error.message}`);
  return r.status ?? 1;
}
