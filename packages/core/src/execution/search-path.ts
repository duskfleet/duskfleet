/**
 * PATH for hosts that start us with a missing or minimal one.
 *
 * A GUI-launched MCP host (Claude Desktop on macOS, a launchd job) inherits launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin`, or no PATH at all: `claude`, `node` and `git` installed by
 * Homebrew or under /usr/local are then invisible, to the binary lookup and to the child run.
 * In that case the usual install directories are put in front. A PATH with anything beyond the
 * system directories is a real shell PATH and is left untouched.
 *
 * macOS only: that is where GUI hosts and launchd hand out such a PATH. On Linux a
 * `PATH=/usr/bin:/bin` is a deliberate choice (systemd --user gives a full one) and is kept.
 */
import path from "node:path";

/** Prepended, in this order, when the PATH is missing or minimal. */
export const DEFAULT_PATH_DIRS: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** The directories a minimal (launchd / GUI) PATH is made of. */
const SYSTEM_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/** True when `pathEnv` is missing, empty, or only lists system directories. */
export function isMinimalPath(pathEnv: string | undefined): boolean {
  const dirs = (pathEnv ?? "").split(":").filter(Boolean);
  return dirs.every((d) => SYSTEM_DIRS.has(d));
}

/**
 * The PATH DuskFleet uses to find `claude` and passes to its runs: `pathEnv` itself, or, when it
 * is missing or minimal, the default install directories followed by it (no duplicates).
 * Only on macOS: elsewhere (Linux, Windows) `pathEnv` is returned as it is.
 * `pathEnv` has no default on purpose: `undefined` means "no PATH", not "the current one".
 */
export function effectivePath(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (!pathDefaulted(pathEnv, platform)) return pathEnv ?? "";
  const existing = (pathEnv ?? "").split(path.posix.delimiter).filter(Boolean);
  return [...new Set([...DEFAULT_PATH_DIRS, ...existing])].join(path.posix.delimiter);
}

/** Whether `effectivePath` puts the default directories in front of `pathEnv` on `platform`. */
export function pathDefaulted(pathEnv: string | undefined, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && isMinimalPath(pathEnv);
}

/**
 * `env` with its PATH replaced by the effective one, for every process DuskFleet spawns (runs,
 * gate commands, git): a copy, or `env` itself when nothing changes.
 */
export function withEffectivePath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!pathDefaulted(env["PATH"], platform)) return env;
  return { ...env, PATH: effectivePath(env["PATH"], platform) };
}
