/**
 * The MCP host entry for this install: what `duskfleet mcp register` writes (Claude Desktop) or
 * runs (`claude mcp add`), and what the dashboard's /mcp page shows. One renderer, so the page and
 * `mcp register --dry-run` print the same configuration for the same host.
 *
 * The command registered (a decision of issue #201, trade-offs in docs/mcp-server.md):
 * absolute `node` + absolute `dist/index.js` of this install, because a GUI host starts with a
 * minimal PATH and Claude Desktop does not expand `~`. Only when the install sits in npx's
 * temporary cache (which npm evicts) is the entry `npx -y -p duskfleet@<version> duskfleet-mcp`,
 * with npx's absolute path next to node: pinned, survives the eviction, needs the network on
 * the host's first start.
 */
import { homedir } from "node:os";
import path from "node:path";
import { dataDirFor, findRepoRoot } from "./loader.js";
import type { LocationContext } from "./locations.js";
import type { DataSource } from "./types.js";

/** The name the server is registered under, in both hosts. */
export const SERVER_NAME = "duskfleet";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ServerEntryInput {
  /** Absolute path of the node binary running this CLI. */
  nodeBin: string;
  /** Absolute path of dist/index.js, the MCP server entry next to this CLI. */
  serverEntry: string;
  /** Resolved claude binary, exported as CLAUDE_BIN (GUI hosts have a minimal PATH). */
  claudeBin: string | null;
  /** Config directory to export as DUSKFLEET_CONFIG; null when the server finds it by itself. */
  configDir: string | null;
  /** Data directory to export as DUSKFLEET_DATA (`exportedDataDir`); null or absent when the server resolves it itself. */
  dataDir?: string | null;
  /** Version of the installed package, pinned in the npx form. */
  version: string;
  platform?: NodeJS.Platform;
}

/** True when `file` lives in npx's temporary cache (`.../_npx/<hash>/...`). */
export function inNpxCache(file: string): boolean {
  return path.resolve(file).split(/[\\/]/).includes("_npx");
}

export function serverEntry(input: ServerEntryInput): { entry: McpServerEntry; form: "path" | "npx" } {
  const env: Record<string, string> = {};
  if (input.claudeBin) env["CLAUDE_BIN"] = input.claudeBin;
  if (input.configDir) env["DUSKFLEET_CONFIG"] = input.configDir;
  if (input.dataDir) env["DUSKFLEET_DATA"] = input.dataDir;
  if (inNpxCache(input.serverEntry)) {
    const npx = path.join(
      path.dirname(input.nodeBin),
      (input.platform ?? process.platform) === "win32" ? "npx.cmd" : "npx",
    );
    return {
      form: "npx",
      entry: { command: npx, args: ["-y", "-p", `duskfleet@${input.version}`, "duskfleet-mcp"], env },
    };
  }
  return { form: "path", entry: { command: input.nodeBin, args: [input.serverEntry], env } };
}

/**
 * Where a process started from `entryFile` (dist/cli.js or dist/index.js) runs and which config it
 * must be told about. From a checkout (`repoRoot` found by walking up from the entry) it finds
 * `config/` itself; the resolved config is exported only when it is somewhere else. From an
 * installed package there is no repo root: it runs in the config directory's parent and always
 * gets DUSKFLEET_CONFIG, or it would not find its config.
 */
export function serviceDirs(
  repoRoot: string | null,
  configDir: string,
): { repoRoot: string; configDir: string | null } {
  const resolved = path.resolve(configDir);
  if (repoRoot) {
    return { repoRoot, configDir: resolved === path.resolve(repoRoot, "config") ? null : resolved };
  }
  return { repoRoot: path.dirname(resolved), configDir: resolved };
}

/**
 * The data directory a service unit or an MCP host entry must carry as DUSKFLEET_DATA, or null
 * when the process it starts resolves the same directory by itself. A unit (launchd, systemd,
 * Task Scheduler) and a GUI host do not see this shell's DUSKFLEET_DATA or XDG_* variables:
 * from DUSKFLEET_DATA always, from the user-level default whenever the process, reading the same
 * `configDir` without XDG variables, would derive another directory (XDG_DATA_HOME set here, or
 * XDG_CONFIG_HOME: the exported config is then not its user-level config, so it would fall back to
 * ../data next to it). A data dir from duskfleet.yaml (data_dir or ../data) follows the config,
 * which is exported separately.
 */
export function exportedDataDir(
  dataDir: string,
  dataSource: DataSource,
  configDir: string,
  ctx: LocationContext = {},
): string | null {
  const resolved = path.resolve(dataDir);
  if (dataSource === "env") return resolved;
  if (dataSource !== "user") return null;
  const env = ctx.env ?? process.env;
  // Simulate the unit: same config dir (data_dir is unset, or the source would be "config"), no
  // XDG_* variables; Windows keeps its per-user APPDATA / LOCALAPPDATA.
  const unitEnv: NodeJS.ProcessEnv = { APPDATA: env["APPDATA"], LOCALAPPDATA: env["LOCALAPPDATA"] };
  const derived = path.resolve(dataDirFor(configDir, null, { ...ctx, env: unitEnv }).dataDir);
  return derived === resolved ? null : resolved;
}

export interface McpServerConfigInput {
  /** Absolute path of the install's MCP server entry (dist/index.js). */
  serverEntry: string;
  nodeBin: string;
  claudeBin: string | null;
  /** The loaded config: where it and the database live. */
  config: { configDir: string; dataDir: string; dataSource: DataSource };
  version: string;
  platform?: NodeJS.Platform;
}

/**
 * The entry for this install and config: the config is exported only when the server would not
 * find it by walking up from its entry (same rule as the service unit), the data directory when
 * a GUI host would not derive it (`exportedDataDir`).
 */
export function mcpServerConfig(input: McpServerConfigInput): { entry: McpServerEntry; form: "path" | "npx" } {
  return serverEntry({
    nodeBin: input.nodeBin,
    serverEntry: input.serverEntry,
    claudeBin: input.claudeBin,
    configDir: serviceDirs(findRepoRoot(input.serverEntry), input.config.configDir).configDir,
    dataDir: exportedDataDir(input.config.dataDir, input.config.dataSource, input.config.configDir),
    version: input.version,
    ...(input.platform ? { platform: input.platform } : {}),
  });
}

/** The Claude Desktop JSON snippet for an entry: `{ "mcpServers": { "duskfleet": ... } }`. */
export function desktopSnippet(entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

/** Where Claude Desktop keeps its config, per platform. */
export function desktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env["APPDATA"] || path.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "Claude", "claude_desktop_config.json");
  }
  const xdg = env["XDG_CONFIG_HOME"] || path.join(home, ".config");
  return path.join(xdg, "Claude", "claude_desktop_config.json");
}

/**
 * Arguments of `claude mcp add` for the entry (flags verified against `claude mcp add --help`,
 * see docs/development.md): user scope, stdio (the default transport), `-e KEY=value` per env.
 * The name comes right after `add`: `-e, --env <env...>` is variadic, so a name placed after it
 * would be read as one more env value. `--` then ends the options before the command.
 */
export function claudeCodeAddArgs(entry: McpServerEntry): string[] {
  const env = Object.entries(entry.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["mcp", "add", SERVER_NAME, "--scope", "user", ...env, "--", entry.command, ...entry.args];
}

/** Shell-readable rendering of a command, for the preview. */
export function shellLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}
