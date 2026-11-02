#!/usr/bin/env node
/**
 * Starts the built dashboard (`next start`) from wherever @duskfleet/web is installed.
 *
 * The caller's working directory and environment pass through untouched, so the dashboard finds
 * the same config and database as the CLI: DUSKFLEET_CONFIG (directory holding duskfleet.yaml)
 * when set, otherwise the closest ancestor of the working directory with config/duskfleet.yaml.
 * Listens on 127.0.0.1 only; PORT overrides the port (default 4777, the one the Host check expects).
 * Sends no telemetry: NEXT_TELEMETRY_DISABLED defaults to 1 (on every platform, unlike a script prefix).
 * DUSKFLEET_WEB_DIR tells the server where the package sits (its tools.json copy, a sibling
 * duskfleet package for the MCP page) when there is no checkout above the working directory.
 *
 *   duskfleet-web            # the installed package's bin
 *   npm run start -w @duskfleet/web
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(path.join(appDir, ".next", "BUILD_ID"))) {
  process.stderr.write(`duskfleet-web: no production build in ${appDir}; run "npm run build:web" first\n`);
  process.exit(1);
}

const port = process.env.PORT || "4777";
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, "start", appDir, "--hostname", "127.0.0.1", "--port", port], {
  stdio: "inherit",
  env: { NEXT_TELEMETRY_DISABLED: "1", ...process.env, DUSKFLEET_WEB_DIR: appDir },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
