#!/usr/bin/env node
/**
 * Copies the MCP tool catalogue (packages/mcp/dist/tools.json, written by `npm run build`)
 * into apps/web/tools.json, so the published @duskfleet/web shows the catalogue on its MCP
 * page without a checkout. Run after `next build`; a missing catalogue is a warning (the
 * page then says the catalogue is not built), never a failed build.
 */
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(webDir, "..", "..", "packages", "mcp", "dist", "tools.json");
if (existsSync(source)) {
  copyFileSync(source, path.join(webDir, "tools.json"));
} else {
  process.stderr.write(`copy-tools: ${source} not found; run "npm run build" first to ship the tool catalogue\n`);
}
