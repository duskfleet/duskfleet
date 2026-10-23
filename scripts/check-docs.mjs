#!/usr/bin/env node
/**
 * Docs sync gate (docs/development.md "Quality gates").
 *
 * Fails when
 *   1. an MCP tool the server registers has no row in the tools table of docs/mcp-server.md
 *      (a line starting with "| `<tool>` |"), or
 *   2. a member of the ScheduleOutcome union (packages/core/src/scheduler/types.ts) is not
 *      named in docs/mcp-server.md, or
 *   3. a docs/*.md page is not linked from README.md, or
 *   4. README.md states a tool count ("15 tools", "15 MCP tools") other than the catalogue's.
 *
 * Tool names come from the generated catalogue packages/mcp/dist/tools.json (written by
 * `npm run build`), so this script never imports the server. Run it after the build.
 *
 * Usage: node scripts/check-docs.mjs      (exit 1 with a list of missing entries)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const problems = [];

// 1. Every registered MCP tool has a row in docs/mcp-server.md.
const catalogFile = path.join(root, "packages", "mcp", "dist", "tools.json");
if (!existsSync(catalogFile)) {
  console.error("check-docs: packages/mcp/dist/tools.json not found. Run npm run build first.");
  process.exit(1);
}
const tools = JSON.parse(readFileSync(catalogFile, "utf8")).tools.map((t) => t.name);
const mcpDoc = readFileSync(path.join(root, "docs", "mcp-server.md"), "utf8");
const documented = new Set(
  mcpDoc
    .split("\n")
    .map((line) => /^\|\s*`([A-Za-z0-9_]+)`\s*\|/.exec(line)?.[1])
    .filter(Boolean),
);
for (const tool of tools) {
  if (!documented.has(tool)) problems.push(`docs/mcp-server.md: MCP tool \`${tool}\` has no row in the tools table`);
}

// 2. Every ScheduleOutcome member is named in docs/mcp-server.md (the list_schedules row).
// Read from the TypeScript source with a regex, so the check needs no import of core.
const typesFile = path.join(root, "packages", "core", "src", "scheduler", "types.ts");
const union = /export type ScheduleOutcome\s*=([^;]+);/.exec(readFileSync(typesFile, "utf8"));
if (!union) {
  problems.push("packages/core/src/scheduler/types.ts: `export type ScheduleOutcome = ...;` not found");
} else {
  const outcomes = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  for (const outcome of outcomes) {
    if (!mcpDoc.includes(`\`${outcome}\``)) {
      problems.push(`docs/mcp-server.md: schedule outcome \`${outcome}\` (ScheduleOutcome) is not listed`);
    }
  }
}

// 3. Every docs page is linked from README.md.
const readme = readFileSync(path.join(root, "README.md"), "utf8");
const linked = new Set([...readme.matchAll(/\]\((?:\.\/)?docs\/([^)#\s]+\.md)(?:#[^)\s]*)?\)/g)].map((m) => m[1]));
const pages = readdirSync(path.join(root, "docs"))
  .filter((f) => f.endsWith(".md"))
  .sort();
for (const page of pages) {
  if (!linked.has(page)) problems.push(`README.md: docs/${page} is not linked`);
}

// 4. Every tool count in README.md ("18 tools", "18 MCP tools") matches the catalogue.
for (const m of readme.matchAll(/\b(\d+) (?:MCP )?tools\b/g)) {
  if (Number(m[1]) !== tools.length) {
    problems.push(`README.md: "${m[0]}" but the server registers ${tools.length} MCP tools`);
  }
}

if (problems.length) {
  console.error(`check-docs: ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "\nDocument every tool and schedule outcome in docs/mcp-server.md and link every docs page from README.md.",
  );
  process.exit(1);
}
console.log(`check-docs: ${tools.length} MCP tools documented, ${pages.length} docs pages linked from README.md.`);
