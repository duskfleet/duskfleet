/**
 * `duskfleet mcp status` for a human (DS-33): one row per MCP host (its config file cut in the
 * middle, whether it holds a duskfleet entry, what that entry runs), a `└` line for a config that
 * cannot be read, and the register command for the first host without an entry. Env keys only,
 * never their values (`--json` prints the entry as the host's config holds it).
 */
import type { McpTarget, McpTargetStatus } from "../mcp-register.js";
import { type Cell, type Column, followUp, jsonLine, type RenderOpts, table, tildePath } from "./primitives.js";
import { GLYPH, paint, stateSegments } from "./theme.js";

const TARGET_TITLE: Readonly<Record<McpTarget, string>> = {
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
};

const COLUMNS: readonly Column[] = [
  { header: "HOST", width: 22 },
  { header: "CONFIG", width: 34, flex: true, truncate: "middle" },
  { header: "ENTRY", width: 6 },
  { header: "RUNS", fill: true },
];

function entryCell(s: McpTargetStatus): Cell {
  // The config cannot be read: the error goes on the `└` line.
  if (s.error) return stateSegments(GLYPH.bad, "no", "bad");
  return s.registered ? stateSegments(GLYPH.ok, "yes", "ok") : stateSegments(GLYPH.none, "no", null);
}

function runsText(s: McpTargetStatus): string {
  if (s.command === null) return "-";
  const envKeys = Object.keys(s.env);
  const command = [s.command, ...s.args.map((a) => tildePath(a))].join(" ");
  return envKeys.length ? `${command} · env ${envKeys.join(", ")}` : command;
}

export function renderMcpStatus(statuses: readonly McpTargetStatus[], opts: RenderOpts): string[] {
  const rows = statuses.map((s): Cell[] => [
    TARGET_TITLE[s.target] ?? s.target,
    tildePath(s.configPath),
    entryCell(s),
    runsText(s),
  ]);
  const [header, ...body] = table(COLUMNS, rows, opts);
  const lines = [header!];
  body.forEach((line, i) => {
    lines.push(line);
    const error = statuses[i]!.error;
    if (error) lines.push(followUp(error, 2, opts));
  });
  const missing = statuses.find((s) => !s.registered);
  lines.push("");
  if (missing) {
    lines.push(`register: ${paint("accent", `duskfleet mcp register --target ${missing.target}`, opts)}`);
  }
  lines.push(jsonLine(opts, "env values only with --json"));
  return lines;
}
