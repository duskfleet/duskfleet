/**
 * PATH for hosts that start us with a missing or minimal one.
 *
 * A GUI-launched MCP host (Claude Desktop on macOS, a launchd job) inherits launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin`, or no PATH at all: `claude`, `node` and `git` installed by
 * Homebrew or under /usr/local are then invisible, to the binary lookup and to the child run.
 * In that case the usual install directories are put in front. A PATH with anything beyond the
 * system directories is a real shell PATH and is left untouched.
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
 * Windows is left alone: its PATH is never launchd's and the defaults are POSIX directories.
 */
export function effectivePath(
  pathEnv: string | undefined = process.env["PATH"],
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32" || !isMinimalPath(pathEnv)) return pathEnv ?? "";
  const existing = (pathEnv ?? "").split(path.posix.delimiter).filter(Boolean);
  return [...new Set([...DEFAULT_PATH_DIRS, ...existing])].join(path.posix.delimiter);
}
