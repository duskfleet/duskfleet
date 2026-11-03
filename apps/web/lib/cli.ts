// The CLI commands the dashboard shows for copy-paste, written for the install in use (#347):
// an npm user cannot paste `npm run cli -- ...`, a checkout has no `duskfleet` on its PATH.
// Pure: the server side (lib/data.ts) gathers the facts, this file decides.
import path from "node:path";

/**
 * How Duskfleet is installed where the dashboard runs:
 * - `checkout`: the repo with its sources (packages/mcp), commands are `npm run cli -- <cmd>`;
 * - `global`: the `duskfleet` package on the PATH (npm install -g), commands are `duskfleet <cmd>`;
 * - `npx`: the package lives in npx's temporary cache, commands are `npx -y duskfleet@<version> <cmd>`
 *   (pinned to the running version; `duskfleet` alone is not on the PATH there).
 */
export type InstallForm = "checkout" | "global" | "npx";

export interface Install {
  form: InstallForm;
  /**
   * Version of the running duskfleet package, pinned in the npx form; null when no package.json
   * could be read (the commands are then unpinned, never `duskfleet@unknown`).
   */
  version: string | null;
  /** Absolute dist/index.js of the MCP server of this install; null when it cannot be found. */
  mcpEntry: string | null;
}

export interface InstallFacts {
  /** DUSKFLEET_MCP_ENTRY: dist/index.js next to the CLI that started the dashboard (`duskfleet dashboard`). */
  mcpEntryEnv?: string | undefined;
  /** DUSKFLEET_WEB_DIR: where the @duskfleet/web package sits (set by its bin/start.mjs). */
  webDir?: string | undefined;
  cwd: string;
  /** Core's `findRepoRoot`: closest ancestor holding config/duskfleet.yaml. */
  findRepoRoot: (from: string) => string | null;
  exists: (file: string) => boolean;
  /** Version of the package.json at `file`, null when unreadable. */
  readVersion: (file: string) => string | null;
}

/** The repo checkout above `from`: a config/duskfleet.yaml root that also holds the MCP sources. */
function checkoutRoot(facts: InstallFacts, from: string): string | null {
  const root = facts.findRepoRoot(from);
  return root && facts.exists(path.join(root, "packages", "mcp", "package.json")) ? root : null;
}

/**
 * Which install the dashboard belongs to. The signal is the CLI that started it: `duskfleet
 * dashboard` passes its MCP entry as DUSKFLEET_MCP_ENTRY, a path inside a checkout, npx's cache
 * or a global install. Without it (`npm run web`, or `duskfleet-web` started by hand) the working
 * directory decides: a checkout above it, else a `duskfleet` package next to @duskfleet/web.
 */
export function detectInstall(facts: InstallFacts): Install {
  const fromEnv = facts.mcpEntryEnv || null;
  const root = checkoutRoot(facts, fromEnv ?? facts.cwd);
  if (root) {
    const entry = path.join(root, "packages", "mcp", "dist", "index.js");
    return {
      form: "checkout",
      version: facts.readVersion(path.join(root, "packages", "mcp", "package.json")),
      mcpEntry: facts.exists(entry) ? entry : null,
    };
  }
  // <prefix>/node_modules/@duskfleet/web -> <prefix>/node_modules/duskfleet/dist/index.js
  const sibling = facts.webDir ? path.resolve(facts.webDir, "..", "..", "duskfleet", "dist", "index.js") : null;
  const entry = [fromEnv, sibling].find((f): f is string => !!f && facts.exists(f)) ?? null;
  const version =
    (entry && facts.readVersion(path.resolve(entry, "..", "..", "package.json"))) ||
    (facts.webDir && facts.readVersion(path.join(facts.webDir, "package.json"))) ||
    null;
  return { form: entry && inNpxCache(entry) ? "npx" : "global", version, mcpEntry: entry };
}

/** True when `file` lives in npx's temporary cache (`.../_npx/<hash>/...`); same rule as core's. */
function inNpxCache(file: string): boolean {
  return path.resolve(file).split(/[\\/]/).includes("_npx");
}

/** `duskfleet@<version>`, or plain `duskfleet` (latest) when the version is unknown. */
function packageSpec(version: string | null): string {
  return version ? `duskfleet@${version}` : "duskfleet";
}

/** The prefix that runs the CLI for this install. */
export function cliPrefix(install: Pick<Install, "form" | "version">): string {
  if (install.form === "checkout") return "npm run cli --";
  if (install.form === "npx") return `npx -y ${packageSpec(install.version)}`;
  return "duskfleet";
}

/**
 * The MCP entry to show for this install, or null when none can be written: no entry found, or
 * the npx form without a version (its host entry pins `duskfleet@<version>`; the page then shows
 * `mcp register`, which knows its own version).
 */
export function usableMcpEntry(install: Install): string | null {
  if (!install.mcpEntry) return null;
  if (install.form === "npx" && !install.version) return null;
  return install.mcpEntry;
}

/** A CLI command for this install: `cliCommand(install, "schedules")` -> `duskfleet schedules`. */
export function cliCommand(install: Pick<Install, "form" | "version">, args: string): string {
  return `${cliPrefix(install)} ${args}`;
}

/**
 * `install-service` for this install. npx refuses it (the unit would point into a cache npm
 * evicts), so that form installs the package globally first.
 */
export function installServiceCommand(install: Pick<Install, "form" | "version">): string {
  if (install.form === "npx") return `npm install -g ${packageSpec(install.version)} && duskfleet install-service`;
  return cliCommand(install, "install-service");
}
