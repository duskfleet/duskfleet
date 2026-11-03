/**
 * The environment DuskFleet hands to the processes it spawns for a run: the Claude child and
 * the schedule command gates.
 *
 * An allow-list, not a copy: whatever the shell that started the MCP server or `serve` holds
 * (`GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`...) would otherwise be readable by every agent through
 * `Bash` and by every gate. What a run needs beyond the defaults is named in
 * `claude.env_passthrough` (duskfleet.yaml) or an agent's `env_passthrough`, merged.
 */
import { withEffectivePath } from "./search-path.js";

/**
 * Passed by default. An entry ending in `*` is a prefix. Windows names are matched without
 * regard to case (its environment is case-insensitive: `Path`, `SystemRoot`).
 */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_*",
  "TMPDIR",
  "TERM",
  "TZ",
  "ANTHROPIC_*",
  "CLAUDE_*",
  "NODE_*",
  "npm_config_*",
  "XDG_*",
  // Windows basics: without them node, npm and claude itself misbehave there.
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "USERNAME",
  "TEMP",
  "TMP",
];

/**
 * Never passed, whatever an allow-list says: markers that make Claude Code believe it is nested
 * inside another session, and `CLAUDE_BIN` (an agent running `npm test` here would launch the
 * real claude instead of the test double).
 */
const ALWAYS_DROPPED: readonly string[] = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_*", "CLAUDE_BIN"];

/** An `env_passthrough` entry: an exact variable name or `PREFIX_*`. */
export const ENV_PASSTHROUGH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\*?$/;

/** Whether `name` matches `pattern` (exact, or a prefix when the pattern ends in `*`). */
export function envNameMatches(name: string, pattern: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === "win32";
  const n = fold ? name.toUpperCase() : name;
  const p = fold ? pattern.toUpperCase() : pattern;
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/**
 * `source` reduced to the default allow-list plus `passthrough`, without the variables that are
 * always dropped, with the effective PATH (see search-path.ts). A new object: `source` is untouched.
 */
export function childEnv(
  passthrough: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allow = [...DEFAULT_ENV_ALLOW, ...passthrough];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALWAYS_DROPPED.some((p) => envNameMatches(key, p, platform))) continue;
    if (allow.some((p) => envNameMatches(key, p, platform))) env[key] = value;
  }
  // A GUI host's minimal PATH would hide node, git and claude from the run.
  return withEffectivePath(env, platform);
}

/** Global and agent passthrough lists merged, without duplicates. */
export function mergeEnvPassthrough(...lists: (readonly string[] | undefined)[]): string[] {
  return [...new Set(lists.flatMap((l) => l ?? []))];
}
