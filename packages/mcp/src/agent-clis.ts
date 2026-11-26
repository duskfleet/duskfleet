/**
 * The agent CLIs on this machine (issue #489): one entry per harness Duskfleet ships an adapter
 * for (`SHIPPED_HARNESSES`), found or not, its version and its login where the CLI has a verified
 * command for it. `init` step 2 prints them; the guided first run picks among the usable ones.
 * The binary lookup is the one runs use (`resolveClaudeBinary`, `resolveCopilotBinary`,
 * `resolveCodexBinary`), with the same environment allow-list (`childEnv`).
 *
 * Login checks, only commands verified on the installed CLI:
 *   - Claude Code: `claude auth status --json` (verified 2026-10-21).
 *   - Codex CLI: `codex login status` prints "Logged in using ChatGPT" (codex-cli 0.167.1). Any
 *     other output is not interpreted: the login is reported as not confirmed, never as logged out.
 *   - GitHub Copilot CLI and Cursor Agent CLI: no verified command yet; the login is not checked.
 * A CLI is usable when it is found and starts (`--version`); Claude Code also needs its login.
 */
import { execFile } from "node:child_process";
import {
  CODEX_HARNESS,
  COPILOT_HARNESS,
  CodexExecutor,
  CopilotExecutor,
  CURSOR_HARNESS,
  CursorExecutor,
  childEnv,
  DEFAULT_HARNESS,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveCopilotBinary,
  resolveCursorBinary,
  SHIPPED_HARNESSES,
  spawnPlan,
} from "@duskfleet/core";

/** Human name of each shipped harness. */
export const HARNESS_LABELS: Readonly<Record<string, string>> = {
  [DEFAULT_HARNESS]: "Claude Code",
  [COPILOT_HARNESS]: "GitHub Copilot CLI",
  [CODEX_HARNESS]: "Codex CLI",
  [CURSOR_HARNESS]: "Cursor Agent CLI",
};

export const harnessLabel = (name: string): string => HARNESS_LABELS[name] ?? name;

export type CliLogin =
  | { state: "logged-in"; method: string | null }
  | { state: "logged-out" }
  /** No verified command, or an answer that was not understood: `why` says which. */
  | { state: "not-checked"; why: string };

export interface AgentCli {
  harness: string;
  label: string;
  /** Resolved binary; null = not found. */
  binary: string | null;
  version: string | null;
  login: CliLogin | null;
  /** Found, starts, and (Claude Code) logged in. */
  usable: boolean;
  /** One line for init step 2 (without the indent). */
  line: string;
  /** What to do when the CLI is found but not usable; null otherwise (a missing one is optional). */
  fix: string | null;
}

export interface CliSettings {
  claudeBinary: string | null;
  copilotBinary: string | null;
  codexBinary: string | null;
  /** `cursor.binary`; absent = `cursor-agent` on PATH. */
  cursorBinary?: string | null;
  /** `claude.env_passthrough`: the same environment runs get. */
  envPassthrough: string[];
}

export interface LoginStatus {
  loggedIn: boolean;
  /** `authMethod` of the JSON, when given (claude.ai, console, api key...). */
  method: string | null;
}

const THEN = "then check it with: duskfleet doctor --probe";

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

/**
 * Reads the output of `codex login status`. Only the verified answer is interpreted: a line
 * "Logged in using <method>" (codex-cli 0.167.1). Anything else is "not confirmed".
 */
export function parseCodexLoginStatus(output: string): CliLogin {
  const match = /^Logged in(?: using (.+?))?\s*$/m.exec(output);
  if (match) return { state: "logged-in", method: match[1]?.trim() || null };
  const first = output.trim().split("\n")[0]?.trim();
  return {
    state: "not-checked",
    why: `codex login status said ${first ? `"${first}"` : "nothing"}, not "Logged in"`,
  };
}

function codexLogin(binary: string, env: NodeJS.ProcessEnv): Promise<CliLogin> {
  const plan = spawnPlan(binary, ["login", "status"]);
  return new Promise((resolve) => {
    execFile(
      plan.file,
      plan.args,
      { timeout: 15_000, env, windowsVerbatimArguments: plan.windowsVerbatimArguments },
      (_err, stdout, stderr) => resolve(parseCodexLoginStatus(`${String(stdout)}\n${String(stderr)}`)),
    );
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "GitHub Copilot CLI 1.0.112." already names itself; "codex-cli 0.167.1" gets the label in front. */
const named = (label: string, version: string) =>
  version.toLowerCase().startsWith(label.toLowerCase()) ? version : `${label} ${version}`;

function notFound(harness: string): AgentCli {
  const label = harnessLabel(harness);
  return {
    harness,
    label,
    binary: null,
    version: null,
    login: null,
    usable: false,
    line: `${label}: not found (optional; harness: ${harness})`,
    fix: null,
  };
}

async function detectClaude(settings: CliSettings, env: NodeJS.ProcessEnv): Promise<AgentCli> {
  const harness = DEFAULT_HARNESS;
  const label = harnessLabel(harness);
  let binary: string;
  try {
    binary = resolveClaudeBinary(settings.claudeBinary);
  } catch {
    return notFound(harness);
  }
  const base = { harness, label, binary, login: null, usable: false };
  let version: string;
  try {
    version = await claudeVersion(binary, env);
  } catch (err) {
    return {
      ...base,
      version: null,
      line: `${label}: ${binary} --version failed: ${message(err)}`,
      fix: `Claude Code does not start: reinstall it or point CLAUDE_BIN at a working binary, ${THEN}`,
    };
  }
  let status: LoginStatus;
  try {
    status = await readLoginStatus(binary, env);
  } catch (err) {
    return {
      ...base,
      version,
      line: `${label} ${version}: ${message(err)}`,
      fix: `The Claude Code login could not be read: update Claude Code (claude update), ${THEN}`,
    };
  }
  if (!status.loggedIn) {
    return {
      ...base,
      version,
      login: { state: "logged-out" },
      line: `${label} ${version} (${binary}): not logged in`,
      fix: `Claude Code is not logged in: run claude auth login, ${THEN}`,
    };
  }
  return {
    ...base,
    version,
    login: { state: "logged-in", method: status.method },
    usable: true,
    line: `${label} ${version} (${binary}): logged in${status.method ? ` (${status.method})` : ""}`,
    fix: null,
  };
}

/** The binary lookup, the executor (for `--version`) and the override variable of a non-Claude harness. */
function otherCli(
  harness: string,
  settings: CliSettings,
): { binary: string | null; executor: (binary: string) => { version(): Promise<string> }; binVar: string } {
  const envPassthrough = settings.envPassthrough;
  if (harness === CODEX_HARNESS)
    return {
      binary: resolveCodexBinary(settings.codexBinary),
      executor: (binary) => new CodexExecutor({ binary, envPassthrough }),
      binVar: "CODEX_BIN",
    };
  if (harness === CURSOR_HARNESS)
    return {
      binary: resolveCursorBinary(settings.cursorBinary ?? null),
      // `--version` only: no run, so no configuration directory is ever written.
      executor: (binary) => new CursorExecutor({ binary, configRoot: "", envPassthrough }),
      binVar: "CURSOR_BIN",
    };
  return {
    binary: resolveCopilotBinary(settings.copilotBinary),
    executor: (binary) => new CopilotExecutor({ binary, envPassthrough }),
    binVar: "COPILOT_BIN",
  };
}

async function detectOther(harness: string, settings: CliSettings, env: NodeJS.ProcessEnv): Promise<AgentCli> {
  const label = harnessLabel(harness);
  const isCodex = harness === CODEX_HARNESS;
  const cli = otherCli(harness, settings);
  const binary = cli.binary;
  if (!binary) return notFound(harness);
  const executor = cli.executor(binary);
  let version: string;
  try {
    version = await executor.version();
  } catch (err) {
    return {
      harness,
      label,
      binary,
      version: null,
      login: null,
      usable: false,
      line: `${label}: ${binary} --version failed: ${message(err)}`,
      fix: `${label} does not start: reinstall it or point ${cli.binVar} at a working binary, ${THEN}`,
    };
  }
  const login: CliLogin = isCodex
    ? await codexLogin(binary, env)
    : { state: "not-checked", why: "no verified login command for this CLI yet" };
  const said =
    login.state === "logged-in"
      ? `logged in${login.method ? ` (${login.method})` : ""}`
      : login.state === "logged-out"
        ? "not logged in"
        : `login not checked: ${login.why}`;
  return {
    harness,
    label,
    binary,
    version,
    login,
    // Only a verified answer may make a CLI unusable; an unverified one never does.
    usable: login.state !== "logged-out",
    line: `${named(label, version)} (${binary}): ${said}`,
    fix: null,
  };
}

/** Every shipped harness, in `SHIPPED_HARNESSES` order. */
export async function detectAgentClis(settings: CliSettings): Promise<AgentCli[]> {
  const env = childEnv(settings.envPassthrough);
  const result: AgentCli[] = [];
  for (const harness of SHIPPED_HARNESSES) {
    result.push(
      harness === DEFAULT_HARNESS ? await detectClaude(settings, env) : await detectOther(harness, settings, env),
    );
  }
  return result;
}

/** The first run's default: Claude Code when it is usable, else the first usable one; null = none. */
export function defaultHarness(usable: readonly string[]): string | null {
  if (usable.includes(DEFAULT_HARNESS)) return DEFAULT_HARNESS;
  return usable[0] ?? null;
}
