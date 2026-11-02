/**
 * `duskfleet init`: the guided first setup. Each step prints its result and the first failure
 * stops with the fix (exit 1):
 *
 *   1. Node: the version (the >= 24 check already ran in cli.ts, before this code loaded).
 *   2. Claude Code: binary (the executor's lookup), version, login (`claude auth status --json`).
 *   3. Config and data: the user-level directories with the starter duskfleet.yaml
 *      (`initUserConfig`); an existing config is reported and left untouched.
 *   4. MCP registration, optional: asked on a terminal; under --yes only with --mcp <target>.
 *   5. What was created, where, and the next commands.
 *
 * Duskfleet ships no agent (owner decision 2026-10-26): the next commands start with
 * `agents create`. No prompt library: `node:readline/promises`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  type ConfigLocation,
  childEnv,
  initUserConfig,
  loadConfig,
  locateConfig,
  resolveClaudeBinary,
} from "@duskfleet/core";
import { MCP_TARGETS, type McpTarget } from "./mcp-register.js";

export interface InitOptions {
  /** No prompts: steps 1-3 and the summary; MCP registration only with `mcp`. */
  yes: boolean;
  /** `--mcp claude-code|claude-desktop`: register without asking. */
  mcp: McpTarget | null;
  /** Where the CLI runs from (locates a repo-local config like every other command). */
  entryFileUrl: string;
  /** Step 4, run once the config exists; returns the exit code of `mcp register`. */
  registerMcp(target: McpTarget): Promise<number>;
}

export interface LoginStatus {
  loggedIn: boolean;
  /** `authMethod` of the JSON, when given (claude.ai, console, api key...). */
  method: string | null;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string) => process.stderr.write(`${s}\n`);

/**
 * Reads `claude auth status --json` (verified against `claude auth status --help` on 2026-10-21).
 * Logged in = the JSON says `loggedIn: true`; logged out = `loggedIn: false` (the command then
 * also exits 1). Anything else (no JSON at all) throws: the login cannot be told.
 */
export function readLoginStatus(binary: string, env: NodeJS.ProcessEnv): Promise<LoginStatus> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["auth", "status", "--json"], { timeout: 15_000, env }, (err, stdout, stderr) => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(String(stdout).trim());
      } catch {
        // handled below
      }
      if (parsed && typeof parsed === "object" && typeof (parsed as { loggedIn?: unknown }).loggedIn === "boolean") {
        const p = parsed as { loggedIn: boolean; authMethod?: unknown };
        resolve({ loggedIn: p.loggedIn, method: typeof p.authMethod === "string" ? p.authMethod : null });
        return;
      }
      const detail = String(stderr).trim() || (err ? err.message : `unexpected output: ${String(stdout).trim()}`);
      reject(new Error(`could not read the login status (claude auth status --json): ${detail}`));
    });
  });
}

function claudeVersion(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { timeout: 15_000, env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

/** claude.binary and claude.env_passthrough of an existing config, so a second init sees what runs see. */
function existingClaudeSettings(location: ConfigLocation): { binary: string | null; passthrough: string[] } {
  if (!existsSync(path.join(location.configDir, "duskfleet.yaml"))) return { binary: null, passthrough: [] };
  try {
    const config = loadConfig(location.configDir);
    return { binary: config.claude.binary, passthrough: config.claude.envPassthrough };
  } catch {
    return { binary: null, passthrough: [] }; // step 3 reports the config; doctor explains a broken one
  }
}

async function askMcpTarget(): Promise<McpTarget | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question("Register the MCP server in Claude Code / Claude Desktop / skip? [code/desktop/skip] ")
    )
      .trim()
      .toLowerCase();
    if (["code", "claude-code", "claude code", "c"].includes(answer)) return "claude-code";
    if (["desktop", "claude-desktop", "claude desktop", "d"].includes(answer)) return "claude-desktop";
    return null;
  } finally {
    rl.close();
  }
}

/** Runs the setup; returns the exit code (0, or 1 at the first failed step). */
export async function runInit(options: InitOptions): Promise<number> {
  if (options.mcp && !MCP_TARGETS.includes(options.mcp)) {
    fail(`--mcp must be ${MCP_TARGETS.join(" or ")}`);
    return 2;
  }
  const location = locateConfig(options.entryFileUrl);
  const created: string[] = [];

  // 1. Node
  out(`[1/5] Node ${process.version}: ok`);

  // 2. Claude Code: same lookup and environment allow-list as the executor.
  const settings = existingClaudeSettings(location);
  const env = childEnv(settings.passthrough);
  let binary: string;
  try {
    binary = resolveClaudeBinary(settings.binary);
  } catch (err) {
    fail(`[2/5] Claude Code: not found\n${err instanceof Error ? err.message : String(err)}`);
    fail("Install Claude Code (https://docs.claude.com/en/docs/claude-code), then run init again.");
    return 1;
  }
  let version: string;
  try {
    version = await claudeVersion(binary, env);
  } catch (err) {
    fail(`[2/5] Claude Code: ${binary} --version failed: ${err instanceof Error ? err.message : String(err)}`);
    fail("Reinstall Claude Code or point CLAUDE_BIN at a working binary, then run init again.");
    return 1;
  }
  let login: LoginStatus;
  try {
    login = await readLoginStatus(binary, env);
  } catch (err) {
    fail(`[2/5] Claude Code ${version}: ${err instanceof Error ? err.message : String(err)}`);
    fail("Update Claude Code (claude update), then run init again.");
    return 1;
  }
  if (!login.loggedIn) {
    fail(`[2/5] Claude Code ${version} (${binary}): not logged in`);
    fail("Log in, then run init again:\n  claude auth login");
    return 1;
  }
  out(`[2/5] Claude Code ${version} (${binary}): logged in${login.method ? ` (${login.method})` : ""}`);

  // 3. Config and data
  const yamlPath = path.join(location.configDir, "duskfleet.yaml");
  if (existsSync(yamlPath)) {
    out(`[3/5] Config: ${yamlPath} already exists (${location.source}); left as it is`);
  } else if (location.source === "user") {
    const result = initUserConfig();
    created.push(...result.created);
    out(`[3/5] Config: created ${yamlPath}\n      Data directory: ${result.dataDir}`);
  } else {
    fail(`[3/5] Config: DUSKFLEET_CONFIG points to ${location.configDir}, which has no duskfleet.yaml`);
    fail("Unset DUSKFLEET_CONFIG to use the user-level directory, or point it at an existing config.");
    return 1;
  }
  try {
    loadConfig(location.configDir);
  } catch (err) {
    fail(`[3/5] Config: ${yamlPath} does not load: ${err instanceof Error ? err.message : String(err)}`);
    fail("Fix the file (duskfleet doctor shows the details), then run init again.");
    return 1;
  }

  // 4. MCP registration (optional)
  let target = options.mcp;
  if (!target && !options.yes) {
    if (process.stdin.isTTY) target = await askMcpTarget();
    else out("[4/5] MCP registration: skipped (not a terminal; pass --mcp claude-code|claude-desktop)");
  }
  if (target) {
    out(`[4/5] MCP registration: ${target}`);
    const code = await options.registerMcp(target);
    if (code !== 0) {
      fail(
        `[4/5] MCP registration failed (exit ${code}); run it again with: duskfleet mcp register --target ${target}`,
      );
      return code;
    }
  } else if (options.yes || process.stdin.isTTY) {
    out("[4/5] MCP registration: skipped (later: duskfleet mcp register --target claude-code|claude-desktop)");
  }

  // 5. Summary and next commands
  out(`[5/5] Done. ${created.length ? `Created: ${created.join(", ")}` : "Nothing was created."}`);
  out(
    [
      "",
      "Next:",
      "  duskfleet doctor",
      '  duskfleet agents create fixer --model haiku -- "You fix failing tests. Run the tests, fix the code, run them again."',
      '  duskfleet run --project <absolute path> --agent fixer -- "Make the tests pass"',
    ].join("\n"),
  );
  return 0;
}
