/**
 * `duskfleet mcp status` for a human (DS-33): one row per MCP host (its config file cut in the
 * middle, whether it holds a duskfleet entry, what that entry runs), a `└` line for a config that
 * cannot be read, the config and data directories a registered entry resolves to, a host's caveat
 * (Copilot's organization policy, a CLI not installed), then one warning per host that opens
 * another database than this install (issue #477), and the register command for the first host
 * without an entry. Env keys only, never their values (`--json` prints the entry as the host's
 * config holds it).
 */
import { HOST_TITLE, type McpTargetStatus } from "../mcp-register.js";
import { type Cell, type Column, followUp, jsonLine, type RenderOpts, table, tildePath } from "./primitives.js";
import { GLYPH, paint, stateSegments } from "./theme.js";

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

/** `warnings`: `dataDirWarnings` of the same statuses (hosts that open another database). */
export function renderMcpStatus(
  statuses: readonly McpTargetStatus[],
  opts: RenderOpts,
  warnings: readonly string[] = [],
): string[] {
  const rows = statuses.map((s): Cell[] => [
    HOST_TITLE[s.target] ?? s.target,
    tildePath(s.configPath),
    entryCell(s),
    runsText(s),
  ]);
  const [header, ...body] = table(COLUMNS, rows, opts);
  const lines = [header!];
  body.forEach((line, i) => {
    lines.push(line);
    const s = statuses[i]!;
    if (s.error) lines.push(followUp(s.error, 2, opts));
    if (s.dataDir) {
      lines.push(followUp(`data ${tildePath(s.dataDir)}`, 2, opts));
      if (s.configDir) lines.push(followUp(`config ${tildePath(s.configDir)}`, 2, opts));
    }
    if (s.note) lines.push(followUp(s.note, 2, opts));
  });
  if (warnings.length) {
    lines.push("");
    for (const w of warnings) lines.push(`${paint("warn", GLYPH.warn, opts)} ${w}`);
  }
  const missing = statuses.find((s) => !s.registered);
  lines.push("");
  if (missing) {
    lines.push(`register: ${paint("accent", `duskfleet mcp register --target ${missing.target}`, opts)}`);
  }
  lines.push(jsonLine(opts, "env values only with --json"));
  return lines;
}
