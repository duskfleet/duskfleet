/**
 * User-level locations: where config and data live when Duskfleet runs outside a checkout
 * (`npx duskfleet`, a global install). A clone keeps its repo-local `config/` and `data/`.
 *
 *   Linux, macOS: config $XDG_CONFIG_HOME/duskfleet (~/.config/duskfleet),
 *                 data   $XDG_DATA_HOME/duskfleet   (~/.local/share/duskfleet)
 *   Windows:      config %APPDATA%\duskfleet, data %LOCALAPPDATA%\duskfleet (experimental)
 *
 * macOS uses the XDG paths, not ~/Library/Application Support: Duskfleet is a terminal tool
 * (like claude's ~/.claude or gh's ~/.config/gh), the paths have no space to quote in service
 * units, shell commands and `add_dirs`, and the docs stay one set of paths for Linux and macOS.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** What the location helpers read; the defaults are this process. Tests pass their own. */
export interface LocationContext {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

const APP_DIR = "duskfleet";

function context(ctx: LocationContext): Required<LocationContext> {
  return { env: ctx.env ?? process.env, platform: ctx.platform ?? process.platform, home: ctx.home ?? homedir() };
}

/** An XDG variable counts only when it is an absolute path (the spec says to ignore relative ones). */
function xdg(value: string | undefined): string | null {
  return value && path.isAbsolute(value) ? value : null;
}

/** The user-level config directory (holds duskfleet.yaml, agents/, projects.yaml). */
export function userConfigDir(ctx: LocationContext = {}): string {
  const { env, platform, home } = context(ctx);
  if (platform === "win32") {
    return path.win32.join(env["APPDATA"] || path.win32.join(home, "AppData", "Roaming"), APP_DIR);
  }
  return path.join(xdg(env["XDG_CONFIG_HOME"]) ?? path.join(home, ".config"), APP_DIR);
}

/** The user-level data directory (duskfleet.db, logs/, user agents, the private projects.yaml). */
export function userDataDir(ctx: LocationContext = {}): string {
  const { env, platform, home } = context(ctx);
  if (platform === "win32") {
    return path.win32.join(env["LOCALAPPDATA"] || path.win32.join(home, "AppData", "Local"), APP_DIR);
  }
  return path.join(xdg(env["XDG_DATA_HOME"]) ?? path.join(home, ".local", "share"), APP_DIR);
}

/** DUSKFLEET_DATA, when set: the data directory whatever the config says. */
export function dataDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env["DUSKFLEET_DATA"];
  if (!value) return null;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

/** The duskfleet.yaml written into a fresh user-level config directory. No agent: Duskfleet ships none. */
export const STARTER_CONFIG = `# Duskfleet configuration (user-level). Every key is optional; see docs/configuration.md.
#
# Data (SQLite database, logs, your agents, your projects.yaml) lives in the user-level data
# directory unless DUSKFLEET_DATA is set or data_dir is given here.
# data_dir: ~/somewhere/else

# Duskfleet ships no starter agent: create your first one with
#   duskfleet agents create <id> --model haiku -- "<system prompt>"
default_agent: null

max_concurrent_runs: 2

scheduler:
  enabled: true
`;

export interface InitUserConfigResult {
  configDir: string;
  dataDir: string;
  /** Files this call wrote (empty when the config was already there: it is never overwritten). */
  created: string[];
}

/**
 * Creates the user-level config directory with a starter duskfleet.yaml, and the data directory,
 * when they are missing. Idempotent and never overwrites. The CLI calls it from `init` or on
 * first use; which one is the onboarding flow's decision, not this function's.
 */
export function initUserConfig(ctx: LocationContext = {}): InitUserConfigResult {
  const configDir = userConfigDir(ctx);
  const dataDir = dataDirFromEnv(ctx.env) ?? userDataDir(ctx);
  const created: string[] = [];
  mkdirSync(configDir, { recursive: true });
  const yamlPath = path.join(configDir, "duskfleet.yaml");
  if (!existsSync(yamlPath)) {
    writeFileSync(yamlPath, STARTER_CONFIG, { flag: "wx" });
    created.push(yamlPath);
  }
  mkdirSync(dataDir, { recursive: true });
  return { configDir, dataDir, created };
}
