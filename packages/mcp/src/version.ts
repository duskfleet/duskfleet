import { readFileSync } from "node:fs";

/**
 * The version of the package this file ships in: the package.json one level above dist/, so the
 * published `duskfleet` package reports its own version (not core's, which is bundled under
 * dist/core). Imports nothing else, so `--version` works before the Node version check.
 */
export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "unknown";
}

/** `--version` / `-v` as the only argument: print the version and exit 0. */
export function handleVersionFlag(args: readonly string[]): void {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`${packageVersion()}\n`);
    process.exit(0);
  }
}
