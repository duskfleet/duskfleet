/**
 * `duskfleet mcp register` / `duskfleet mcp status`: add the Duskfleet MCP server to an MCP
 * host (Claude Code, Claude Desktop, Copilot CLI, Codex CLI), showing the exact change first.
 *
 *   claude-code     `claude mcp add --scope user ...` (printed before it runs); status reads
 *                   the user-scope `mcpServers` of `~/.claude.json`
 *   claude-desktop  `mcpServers.duskfleet` of claude_desktop_config.json: a unified diff of the
 *                   entry, a `.bak-<timestamp>` copy of the file, then the write. A file that is
 *                   not valid JSON is never overwritten.
 *   copilot, codex  `copilot mcp add` / `codex mcp add` (printed before it runs, issue #477); status
 *                   reads `<cli> mcp list --json`. Duskfleet never edits their config files.
 *
 * `withDirs` adds the config and data directories each entry resolves to: every host should
 * drive the same database as this install, and `mcp status` / `doctor` warn when one does not.
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
import {
  claudeCodeAddArgs,
  desktopConfigPath,
  entryDirs,
  hostCliAddArgs,
  type LocationContext,
  type McpServerEntry,
  resolveCodexBinary,
  resolveCopilotBinary,
  SERVER_NAME,
  shellLine,
} from "@duskfleet/core";

export {
  claudeCodeAddArgs,
  desktopConfigPath,
  hostCliAddArgs,
  inNpxCache,
  type McpServerEntry,
  SERVER_NAME,
  type ServerEntryInput,
  serverEntry,
  shellLine,
} from "@duskfleet/core";

export const MCP_TARGETS = ["claude-code", "claude-desktop", "copilot", "codex"] as const;
export type McpTarget = (typeof MCP_TARGETS)[number];

/** The hosts registered through their own CLI's `mcp add` (issue #477), not through a file Duskfleet edits. */
export const HOST_CLI_TARGETS = ["copilot", "codex"] as const;
export type HostCliTarget = (typeof HOST_CLI_TARGETS)[number];

export function isHostCliTarget(target: McpTarget): target is HostCliTarget {
  return (HOST_CLI_TARGETS as readonly string[]).includes(target);
}

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
  /** The config directory the entry resolves to (`withDirs`); null when not registered or unknown. */
  configDir?: string | null;
  /** The data directory (the database) the entry resolves to; null when not registered or unknown. */
  dataDir?: string | null;
  /** False: the entry opens another database than this install's (or than the other hosts'). Null: unknown. */
  sameData?: boolean | null;
  /** A caveat on this host (Copilot's organization policy, a CLI that is not installed, env not listed). */
  note?: string | null;
  /** False when the host's listing does not show the entry's env (it is then not compared). */
  envKnown?: boolean;
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

// ---- Copilot CLI, Codex CLI (issue #477) ------------------------------------------

/** The binaries of the CLI hosts, null when not installed. */
export interface HostBinaries {
  copilot: string | null;
  codex: string | null;
}

/** Same lookup as the harnesses (`COPILOT_BIN` / `CODEX_BIN` > the config's binary > PATH). */
export function hostBinaries(
  configured: { copilot?: string | null | undefined; codex?: string | null | undefined } = {},
  env: NodeJS.ProcessEnv = process.env,
): HostBinaries {
  return {
    copilot: resolveCopilotBinary(configured.copilot ?? null, env),
    codex: resolveCodexBinary(configured.codex ?? null, env),
  };
}

export const HOST_TITLE: Readonly<Record<McpTarget, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  copilot: "Copilot CLI",
  codex: "Codex CLI",
};

const BIN_VAR: Readonly<Record<HostCliTarget, string>> = { copilot: "COPILOT_BIN", codex: "CODEX_BIN" };

/**
 * The extra env of a Copilot / Codex entry: `COPILOT_BIN` / `CODEX_BIN` when the binary was
 * resolved outside PATH (the variable itself, or the config's binary), so the server the host
 * starts with its own PATH finds the same CLI for its runs.
 */
export function hostBinEnv(
  target: HostCliTarget,
  binary: string | null,
  configured: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const name = BIN_VAR[target];
  return binary && (env[name] || configured) ? { [name]: binary } : {};
}

/** Where the host CLI keeps the entry `mcp add` writes (shown only; Duskfleet never edits it). */
export function hostConfigPath(target: HostCliTarget, home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (target === "copilot") return path.join(home, ".copilot", "mcp-config.json");
  return path.join(env["CODEX_HOME"] || path.join(home, ".codex"), "config.toml");
}

/**
 * After a Copilot registration, and on its status row: an organization can disable third-party
 * MCP servers by policy (seen on 1.0.112: the server is then blocked at session start), which
 * Duskfleet cannot detect before a session starts.
 */
export const COPILOT_POLICY_NOTE =
  "if the tools do not appear, your organization's Copilot policy may disable third-party MCP servers " +
  '("Third-party MCP servers are disabled by your organization\'s Copilot policy. Only built-in servers are available."): ' +
  "that is the organization's setting (an allow-listed MCP registry), not something Duskfleet can change";

/**
 * The `duskfleet` entry in a host CLI's `mcp list --json` (shapes recorded on Copilot CLI 1.0.114
 * and codex-cli 0.167.1): Copilot `{ mcpServers: { <name>: { type, command, args, source, ... } } }`
 * (a builtin server of that name does not count), Codex `[{ name, transport: { type, command, args,
 * env } }]`. Null when absent. Throws on output that is not the recorded shape.
 */
export function parseHostListing(
  target: HostCliTarget,
  stdout: string,
): { command: string | null; args: string[]; env: Record<string, string>; envKnown: boolean } | null {
  const parsed: unknown = JSON.parse(stdout);
  let entry: unknown;
  if (target === "copilot") {
    if (!isObject(parsed) || !isObject(parsed["mcpServers"])) throw new Error("no mcpServers object");
    entry = parsed["mcpServers"][SERVER_NAME];
    if (isObject(entry) && entry["source"] === "builtin") return null;
  } else {
    if (!Array.isArray(parsed)) throw new Error("not an array");
    const found = parsed.find((s) => isObject(s) && s["name"] === SERVER_NAME);
    entry = isObject(found) ? found["transport"] : undefined;
  }
  if (!isObject(entry)) return null;
  const env = entry["env"];
  return {
    command: typeof entry["command"] === "string" ? entry["command"] : null,
    args: Array.isArray(entry["args"]) ? entry["args"].map(String) : [],
    env: stringRecord(env),
    // Codex lists `env` (null when there is none); whether Copilot's listing carries it is unverified.
    envKnown: isObject(env) || (target === "codex" && env === null),
  };
}

function hostCliStatus(
  target: HostCliTarget,
  binary: string | null,
  home: string,
  env: NodeJS.ProcessEnv,
): McpTargetStatus {
  const base: McpTargetStatus = {
    target,
    configPath: hostConfigPath(target, home, env),
    registered: false,
    command: null,
    args: [],
    env: {},
    error: null,
    note: null,
  };
  if (!binary) {
    return { ...base, note: `${HOST_TITLE[target]} not found (${BIN_VAR[target]}, ${target}.binary or PATH)` };
  }
  const r = spawnSync(binary, ["mcp", "list", "--json"], {
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: process.env,
  });
  const failed = r.error?.message ?? (r.status !== 0 ? (r.stderr || "").trim().split("\n").at(-1) : null);
  if (failed) return { ...base, error: `${binary} mcp list --json failed: ${failed || `exit ${r.status}`}` };
  let found: ReturnType<typeof parseHostListing>;
  try {
    found = parseHostListing(target, r.stdout);
  } catch (err) {
    return {
      ...base,
      error: `${binary} mcp list --json: unexpected output (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!found) return base;
  const { envKnown, ...entry } = found;
  const notes = [
    target === "copilot" ? COPILOT_POLICY_NOTE : null,
    envKnown ? null : "the listing shows no env for the entry: its env and data directory are not compared",
  ].filter(Boolean);
  return { ...base, registered: true, ...entry, envKnown, note: notes.length ? notes.join("; ") : null };
}

/**
 * Each registered entry's config and data directories (`entryDirs`), and whether it opens the
 * same database as this install (`installDataDir`; without one, as the first registered host).
 */
export function withDirs(
  statuses: readonly McpTargetStatus[],
  installDataDir: string | null,
  ctx: LocationContext = {},
): McpTargetStatus[] {
  const resolved = statuses.map((s) => {
    if (!s.registered || s.command === null || s.envKnown === false) {
      return { ...s, configDir: null, dataDir: null, sameData: null };
    }
    const dirs = entryDirs(s, ctx);
    return { ...s, configDir: dirs?.configDir ?? null, dataDir: dirs?.dataDir ?? null };
  });
  const reference = installDataDir ? path.resolve(installDataDir) : (resolved.find((s) => s.dataDir)?.dataDir ?? null);
  return resolved.map((s) => ({ ...s, sameData: s.dataDir && reference ? s.dataDir === reference : null }));
}

/** One line per host whose entry opens another database (`withDirs` ran first). */
export function dataDirWarnings(statuses: readonly McpTargetStatus[], installDataDir: string | null): string[] {
  const reference = installDataDir ?? statuses.find((s) => s.dataDir)?.dataDir ?? null;
  return statuses
    .filter((s) => s.sameData === false)
    .map(
      (s) =>
        `${HOST_TITLE[s.target]} uses the data directory ${s.dataDir}, ${installDataDir ? "this install uses" : "the other hosts use"} ${reference}: the agents, runs and schedules it creates go to another database the dashboard does not show; register it again from this install (duskfleet mcp register --target ${s.target}, after removing the old entry)`,
    );
}

/** `mcp status`: whether each host has a `duskfleet` entry and what it runs. Read-only. */
export function mcpStatus(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  binaries: HostBinaries = hostBinaries(),
): McpTargetStatus[] {
  return [
    statusFrom("claude-code", claudeCodeConfigPath(home)),
    statusFrom("claude-desktop", desktopConfigPath(platform, home, env)),
    hostCliStatus("copilot", binaries.copilot, home, env),
    hostCliStatus("codex", binaries.codex, home, env),
  ];
}

export interface HostCliPlan {
  /** What the preview prints. */
  display: string;
  args: string[];
  upToDate: boolean;
  /** Registered with something else: `mcp add` is not run, the user removes it first. */
  conflict: McpTargetStatus | null;
}

/** What `register --target copilot|codex` would run. Throws when the host's listing cannot be read. */
export function planHostCli(
  target: HostCliTarget,
  binary: string,
  entry: McpServerEntry,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): HostCliPlan {
  const status = hostCliStatus(target, binary, home, env);
  if (status.error) throw new Error(`${status.error}; nothing was changed`);
  const args = hostCliAddArgs(entry);
  const same =
    status.registered &&
    status.command === entry.command &&
    JSON.stringify(status.args) === JSON.stringify(entry.args) &&
    (status.envKnown === false || sameEnv(status.env, entry.env));
  return {
    display: shellLine(target, args),
    args,
    upToDate: same,
    conflict: status.registered && !same ? status : null,
  };
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

/** Run `claude mcp add` (or `copilot` / `codex mcp add`), its output on this terminal. Returns the exit status. */
export function runClaudeCodeAdd(claudeBin: string, args: string[]): number {
  const r = spawnSync(claudeBin, args, { stdio: "inherit", windowsHide: true });
  if (r.error) throw new Error(`could not run ${claudeBin}: ${r.error.message}`);
  return r.status ?? 1;
}
