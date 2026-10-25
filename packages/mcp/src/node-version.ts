/**
 * Node version gate for both bins (dist/cli.js, dist/index.js).
 *
 * Duskfleet needs Node 24 for the built-in `node:sqlite`. On an older runtime the import
 * fails while linking with ERR_UNKNOWN_BUILTIN_MODULE, before any code of ours runs, so
 * the bins import only this module statically, call `checkNodeVersion()` and then load
 * the real entry with a dynamic import. Keep this file free of imports and of recent
 * syntax: it must load on old runtimes.
 */

export const MIN_NODE_MAJOR = 24;

/** The message for a version below the minimum, or null when the version is fine. */
export function nodeVersionProblem(version: string): string | null {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0] || "", 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) return null;
  return `Duskfleet needs Node ${MIN_NODE_MAJOR} or newer; you have v${String(version).replace(/^v/, "")}`;
}

/** Prints the message to stderr and exits 1 when the running Node is too old. Silent otherwise. */
export function checkNodeVersion(): void {
  const problem = nodeVersionProblem(process.versions.node);
  if (problem === null) return;
  process.stderr.write(`${problem}\n`);
  process.exit(1);
}
