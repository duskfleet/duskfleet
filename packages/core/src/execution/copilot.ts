/**
 * GitHub Copilot CLI executor (`harness: copilot`, issue #446, docs/harnesses.md).
 *
 * Flags verified against `copilot --help` and real runs of Copilot CLI 1.0.112 (fixtures in
 * `packages/mcp/test/fixtures/copilot/`). What the adapter does with them:
 *
 * - the prompt goes on stdin (no `-p`: same stream, the prompt stays out of argv and `ps`);
 * - `--output-format json` (JSONL), `--no-ask-user`, `--no-auto-update` (a run must not change the
 *   CLI under it), `--disable-builtin-mcps` (runs are strict-MCP), always;
 * - `--disable-mcp-server <name>` for every other server `copilot mcp list --json` names in the
 *   run's folder (user-level, trusted workspace, plugins), resolved in `prepare` (issue #476);
 * - `--session-id <uuid>` for a fresh session, `--resume=<id>` to continue one;
 * - `allowed_tools` / `disallowed_tools` hold Copilot's own rules, passed verbatim to
 *   `--allow-tool` / `--deny-tool` (copilot-rules.ts); `acceptEdits` adds `--allow-tool write`.
 *   In a non-interactive run a permission request that would prompt is denied: deny by default;
 * - an own agent's system prompt becomes a Copilot agent file in a per-run temp directory, passed
 *   with `--add-dir <tmp> --agent <name>` (there is no system prompt flag, and
 *   `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` is not applied in an untrusted folder);
 * - a link (`project_agent`, #466, 1.0.114) is `--agent <name>` alone: the project's
 *   `.github/agents/<name>.agent.md`, found from the working directory. Its `tools:` only narrow
 *   what the rules allow (fixtures `link-tools-*`); a link with a body is refused;
 * - `--usage-output-file` into the same temp directory: tokens per model for the result.
 *
 * Never passed: `--trust-folder`, `--allow-all-tools`, `--allow-all`, `--yolo`, `--autopilot`;
 * `COPILOT_ALLOW_ALL` never reaches the child, even through an `env_passthrough`.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { listProjectAgents } from "../config/agent-files.js";
import { COPILOT_PROJECT_AGENTS } from "../config/project-agent-folder.js";
import { classifyFailure } from "../observability/failure.js";
import type { RecordedCommand } from "../observability/run.js";
import { logger } from "../util/log.js";
import { childEnv, envNameMatches } from "./child-env.js";
import {
  type CopilotStreamState,
  copilotUsageByModel,
  createCopilotState,
  ingestCopilotLine,
  isCopilotSessionNotFound,
  sumUsage,
} from "./copilot-jsonl.js";
import { copilotRuleRefusal } from "./copilot-rules.js";
import { COPILOT_CAPABILITIES, COPILOT_HARNESS, linkBodyRefusal } from "./harness.js";
import { CappedLogWriter, DEFAULT_MAX_LOG_BYTES } from "./log-caps.js";
import { effectivePath } from "./search-path.js";
import type {
  ExecutionEvent,
  ExecutionHandle,
  ExecutionRequest,
  ExecutionResult,
  Executor,
  PrepareResult,
} from "./types.js";
import { spawnPlan } from "./win-cmd.js";

const log = logger("execution");

export interface CopilotExecutorOptions {
  /** `copilot.binary` from duskfleet.yaml; null = `copilot` on PATH. */
  binary: string | null;
  /** `claude.env_passthrough`, for `copilot --version` (a run gets its own list in the request). */
  envPassthrough?: string[];
  /** How long the process group may outlive the `result` line before it is ended. Default 5 s. */
  resultGraceMs?: number;
}

/** Name of the agent file the persona is written to (`<tmp>/.github/agents/<name>.agent.md`). */
export const COPILOT_PERSONA_AGENT = "duskfleet-agent";
/** Variables that must never reach the child: `"true"` also trusts the folder and loads its hooks. */
const NEVER_PASSED = ["COPILOT_ALLOW_ALL"];
const MCP_LIST_TIMEOUT_MS = 15_000;
const KILL_GRACE_MS = 5_000;
const RESULT_GRACE_MS = 5_000;
const OWN_PROCESS_GROUP = process.platform !== "win32";

export class CopilotExecutor implements Executor {
  readonly name = "copilot-cli";
  readonly harness = COPILOT_HARNESS;
  readonly capabilities = COPILOT_CAPABILITIES;
  readonly binary: string;

  /** Throws when no binary is found; `resolveCopilotBinary` tells beforehand. */
  constructor(private readonly options: CopilotExecutorOptions) {
    const binary = resolveCopilotBinary(options.binary);
    if (!binary) throw new Error(copilotNotFound(options.binary));
    this.binary = binary;
  }

  /** The rules are Copilot's own (also checked at create / update): refuse a Claude-shaped one by name. */
  prepare(request: ExecutionRequest): PrepareResult {
    for (const [field, rules] of [
      ["allowed_tools", request.allowedTools],
      ["disallowed_tools", request.disallowedTools],
    ] as const) {
      for (const rule of rules ?? []) {
        const why = copilotRuleRefusal(rule);
        if (why) throw new Error(`${field} entry "${rule}" ${why}`);
      }
    }
    // The capability check refuses these fields first; a request built elsewhere must not slip through.
    if (request.addDirs?.length) throw new Error("add_dirs is not supported by harness copilot");
    if (request.inheritMcp) throw new Error("inherit_mcp is not supported by harness copilot");
    if (request.sandbox) throw new Error("sandbox is not supported by harness copilot");
    if (request.claudeAgent) {
      // A link runs the project's own agent file. An unknown name ends the CLI before any model
      // call with nothing on stdout (fixture link-unknown): check it here, before the run row exists.
      if (request.appendSystemPrompt)
        throw new Error(linkBodyRefusal(COPILOT_HARNESS, COPILOT_CAPABILITIES, request.claudeAgent));
      const available = listProjectAgents(request.cwd, COPILOT_PROJECT_AGENTS).map((a) => a.name);
      if (!available.includes(request.claudeAgent)) {
        throw new Error(
          `runs as project agent "${request.claudeAgent}", but ${request.cwd}/${COPILOT_PROJECT_AGENTS.dir} has ${available.length ? available.join(", ") : "no agents"}`,
        );
      }
    }
    // User-level and (trusted folder) workspace servers: one --disable-mcp-server each. A listing
    // that fails refuses the run: starting without knowing what would load is not an option.
    const disable = copilotMcpServersToDisable(this.listMcpServers(request));
    if (disable.length) request.disableMcpServers = disable;
    return { notes: [] };
  }

  /**
   * stdout of `copilot mcp list --json` in the run's folder (where a trusted folder's workspace
   * servers are listed too). Synchronous on purpose: `startRun` checks its guards and writes the
   * run row without yielding in between. No model call; stderr carries only warnings.
   */
  private listMcpServers(request: ExecutionRequest): string {
    const plan = spawnPlan(this.binary, ["mcp", "list", "--json"]);
    const r = spawnSync(plan.file, plan.args, {
      cwd: request.cwd,
      env: copilotEnv(request.envPassthrough),
      encoding: "utf8",
      timeout: MCP_LIST_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    if (!r.error && r.status === 0) return r.stdout;
    const why = r.error ? r.error.message : r.status !== null ? `exit ${r.status}` : `signal ${r.signal}`;
    throw new Error(
      `copilot mcp list --json failed (${why}), so the MCP servers to disable are unknown${tail(r.stderr ?? "")}`,
    );
  }

  version(): Promise<string> {
    const plan = spawnPlan(this.binary, ["--version"]);
    return new Promise((resolve, reject) => {
      execFile(
        plan.file,
        plan.args,
        {
          timeout: 15_000,
          env: copilotEnv(this.options.envPassthrough),
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
  }

  /** argv for one run. `workDir` holds the usage file and, with a system prompt, the persona agent. */
  buildArgv(req: ExecutionRequest, workDir: string): string[] {
    if (!COPILOT_CAPABILITIES.permissionModes.includes(req.permissionMode))
      throw new Error(`permission_mode ${req.permissionMode} is not supported by harness copilot`);
    const argv = ["--output-format", "json", "--no-ask-user", "--no-auto-update", "--disable-builtin-mcps"];
    for (const name of req.disableMcpServers ?? []) argv.push("--disable-mcp-server", name);
    argv.push(req.resumeSessionId ? `--resume=${req.resumeSessionId}` : "--session-id");
    if (!req.resumeSessionId) argv.push(req.sessionId);
    if (req.model) argv.push("--model", req.model);
    if (req.effort) argv.push("--reasoning-effort", req.effort);
    if (req.permissionMode === "acceptEdits") argv.push("--allow-tool", "write");
    for (const rule of req.allowedTools ?? []) argv.push("--allow-tool", rule);
    for (const rule of req.disallowedTools ?? []) argv.push("--deny-tool", rule);
    if (req.claudeAgent) {
      // A link (#466): the project's `.github/agents/<name>.agent.md`, found from the working
      // directory, no --add-dir. Nothing can join it, so a body never gets this far.
      if (req.appendSystemPrompt)
        throw new Error(linkBodyRefusal(COPILOT_HARNESS, COPILOT_CAPABILITIES, req.claudeAgent));
      argv.push("--agent", req.claudeAgent);
    } else if (req.appendSystemPrompt) argv.push("--add-dir", workDir, "--agent", COPILOT_PERSONA_AGENT);
    argv.push("--usage-output-file", path.join(workDir, "usage.json"));
    return argv;
  }

  execute(req: ExecutionRequest, onEvent?: (event: ExecutionEvent) => void): ExecutionHandle {
    const emit = (e: ExecutionEvent) => {
      try {
        onEvent?.(e);
      } catch (err) {
        log.warn("event handler threw", { err: String(err) });
      }
    };
    const startedAt = new Date();
    const workDir = mkdtempSync(path.join(tmpdir(), "duskfleet-copilot-"));
    const cleanup = () => rmSync(workDir, { recursive: true, force: true });
    let argv: string[];
    try {
      argv = this.buildArgv(req, workDir);
      if (req.appendSystemPrompt && !req.claudeAgent) writePersona(workDir, req.appendSystemPrompt);
    } catch (err) {
      cleanup();
      throw err;
    }
    const command: RecordedCommand = { binary: this.binary, argv, cwd: req.cwd };

    let logStream: CappedLogWriter | null = null;
    if (req.logPath) {
      logStream = new CappedLogWriter(req.logPath, req.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, (err) =>
        log.warn("log file write failed", { path: req.logPath, err: err.message }),
      );
      if (req.resumeSessionId) logStream.write(`#resume ${req.resumeSessionId} ${startedAt.toISOString()}\n`);
    }

    const state = createCopilotState();
    let outcome: ExecutionResult["outcome"] | null = null; // set by cancel / timeout
    let refusal: string | null = null; // set when the stream shows something the harness must not run with
    let closed = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let resultTimer: NodeJS.Timeout | null = null;
    let graceKilled = false;
    let stderrTail = "";
    // Checked on every chunk: the 4000-character tail may have dropped the line by the end.
    let stderrSessionNotFound = false;
    let spawnError: string | null = null;
    let child: ChildProcess;

    const signal = (sig: NodeJS.Signals) => {
      if (OWN_PROCESS_GROUP && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // ESRCH: the group is gone already.
        }
      }
      child.kill(sig);
    };
    const endGroup = () => {
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) signal("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const terminate = (reason: ExecutionResult["outcome"]) => {
      if (outcome || closed) return;
      outcome = reason;
      log.info(`terminating run (${reason})`, { pid: child.pid });
      endGroup();
    };

    try {
      // A Windows `copilot.cmd` shim needs cmd.exe (Node refuses a batch file without it): win-cmd.ts.
      const plan = spawnPlan(this.binary, argv);
      child = spawn(plan.file, plan.args, {
        cwd: req.cwd,
        env: copilotEnv(req.envPassthrough),
        stdio: ["pipe", "pipe", "pipe"], // stdin carries the prompt, never argv
        shell: false,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: OWN_PROCESS_GROUP,
      });
    } catch (err) {
      cleanup();
      const ended = logStream?.end() ?? Promise.resolve();
      const result = finalResult({
        outcome: "failed",
        error: `spawn failed: ${String(err)}`,
        startedAt,
        endedAt: new Date(),
        exitCode: null,
        signal: null,
        state,
        sessionId: req.sessionId,
        usageFile: null,
        sessionNotFound: false,
      });
      return { command, pid: null, cancel: () => {}, done: ended.then(() => result) };
    }
    child.stdin!.on("error", (err) => log.debug("stdin write failed", { pid: child.pid, err: err.message }));
    child.stdin!.end(req.prompt, "utf8");

    const resultGraceMs = this.options.resultGraceMs ?? RESULT_GRACE_MS;
    const graceKill = () => {
      resultTimer = null;
      if (closed || outcome || graceKilled) return;
      graceKilled = true;
      const childAlive = child.exitCode === null && child.signalCode === null;
      log.warn("process still running after its result line; ending its process group", { pid: child.pid });
      emit({ type: "grace_kill", pid: child.pid ?? null, afterMs: resultGraceMs, childAlive });
      endGroup();
    };

    const done = new Promise<ExecutionResult>((resolve) => {
      const stdout = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
      stdout.on("line", (line) => {
        logStream?.write(`${line}\n`);
        for (const ev of ingestCopilotLine(state, line)) {
          emit(ev);
          if (ev.type !== "init" || refusal || outcome) continue;
          // No MCP for this harness yet (`mcpInherit: false`): `prepare` disabled every server the
          // listing named, so this is the backstop. A server that loaded anyway would hand the
          // agent tools nobody allow-listed: end the run, never ignore it.
          const loaded = ev.mcpServers.filter((s) => s.status !== "disabled").map((s) => s.name);
          if (loaded.length) {
            refusal = `Copilot loaded MCP server${loaded.length > 1 ? "s" : ""} ${loaded.join(", ")}; harness copilot runs without MCP, so the run was stopped`;
            log.warn("copilot loaded MCP servers; ending the run", { pid: child.pid, loaded });
            endGroup();
          }
        }
        if (state.result && !resultTimer && !graceKilled && !closed) resultTimer = setTimeout(graceKill, resultGraceMs);
      });

      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        const window = stderrTail + chunk; // the tail before the cut: a line split across chunks still matches
        if (!stderrSessionNotFound && isCopilotSessionNotFound(0, window)) stderrSessionNotFound = true;
        stderrTail = window.slice(-4000);
        logStream?.write(`#stderr ${chunk.replace(/\n(?!$)/g, "\n#stderr ")}`);
        emit({ type: "stderr", text: chunk });
      });
      child.on("error", (err) => {
        spawnError = err.message;
      });

      child.on("close", (code, sig) => {
        closed = true;
        if (killTimer) clearTimeout(killTimer);
        if (resultTimer) clearTimeout(resultTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const endedAt = new Date();
        const usageFile = readUsageFile(path.join(workDir, "usage.json"));
        cleanup();
        const sessionNotFound = !!req.resumeSessionId && state.lines === 0 && stderrSessionNotFound;
        const exit = state.result?.exitCode ?? code;
        let error: string | null = null;
        let finalOutcome: ExecutionResult["outcome"];
        if (outcome) {
          finalOutcome = outcome;
        } else if (refusal) {
          finalOutcome = "failed";
          error = refusal;
        } else if (spawnError) {
          finalOutcome = "failed";
          error = spawnError;
        } else if (!state.result) {
          finalOutcome = "failed";
          error = `no result line received (exit ${code ?? "null"}, signal ${sig ?? "none"})${tail(stderrTail)}`;
        } else if (state.error || (exit !== null && exit !== 0) || (!graceKilled && code !== null && code !== 0)) {
          finalOutcome = "failed";
          error = state.error?.message ?? `exit code ${exit}${tail(stderrTail)}`;
        } else {
          finalOutcome = "completed";
        }
        resolve(
          finalResult({
            outcome: finalOutcome,
            error,
            startedAt,
            endedAt,
            exitCode: code,
            signal: sig,
            state,
            sessionId: req.resumeSessionId ?? req.sessionId,
            usageFile,
            sessionNotFound,
          }),
        );
      });
    }).then(async (result) => {
      await logStream?.end(); // RunManager hashes the log when the run ends
      return logStream?.truncated ? { ...result, logTruncated: true } : result;
    });

    if (req.timeoutMs && req.timeoutMs > 0) timeoutTimer = setTimeout(() => terminate("timed_out"), req.timeoutMs);

    return { command, pid: child.pid ?? null, done, cancel: () => terminate("cancelled") };
  }
}

/**
 * The run's environment: the shared allow-list, minus what makes Copilot trust everything.
 * Names are matched as `childEnv` matches them: case-insensitively on Windows, where
 * `Copilot_Allow_All` is the same variable as `COPILOT_ALLOW_ALL`.
 */
export function copilotEnv(
  passthrough?: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = childEnv(passthrough, source, platform);
  for (const key of Object.keys(env)) {
    if (NEVER_PASSED.some((p) => envNameMatches(key, p, platform))) delete env[key];
  }
  return env;
}

/**
 * The servers a run must disable, from the stdout of `copilot mcp list --json` (verified on
 * 1.0.112: `{ "mcpServers": { "<name>": { "type", "source", "enabled", ... } } }`): every entry
 * except `"source": "builtin"` ones, which `--disable-builtin-mcps` already covers (so a machine
 * with no server of its own keeps the argv it had). Throws, with the reason, on anything else.
 */
export function copilotMcpServersToDisable(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`copilot mcp list --json did not print JSON: ${JSON.stringify(stdout.trim().slice(0, 200))}`);
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw new Error("copilot mcp list --json printed no mcpServers object");
  return Object.entries(servers as Record<string, unknown>)
    .filter(([, s]) => (s as { source?: unknown } | null)?.source !== "builtin")
    .map(([name]) => name);
}

/** `<dir>/.github/agents/<name>.agent.md`: frontmatter `name` and `description`, body = the system prompt. */
function writePersona(dir: string, systemPrompt: string): void {
  const agents = path.join(dir, ".github", "agents");
  mkdirSync(agents, { recursive: true });
  const body = `---\nname: ${COPILOT_PERSONA_AGENT}\ndescription: Duskfleet agent persona for this run\n---\n\n${systemPrompt}\n`;
  writeFileSync(path.join(agents, `${COPILOT_PERSONA_AGENT}.agent.md`), body, "utf8");
}

function readUsageFile(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function tail(stderr: string): string {
  const t = stderr.trim();
  return t ? `\nstderr: ${t.slice(-1000)}` : "";
}

function finalResult(input: {
  outcome: ExecutionResult["outcome"];
  error: string | null;
  startedAt: Date;
  endedAt: Date;
  exitCode: number | null;
  signal: string | null;
  state: CopilotStreamState;
  sessionId: string;
  usageFile: unknown;
  sessionNotFound: boolean;
}): ExecutionResult {
  const { state } = input;
  const usageByModel = copilotUsageByModel(input.usageFile);
  return {
    outcome: input.outcome,
    sessionId: state.sessionId ?? input.sessionId,
    model: state.model,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    exitCode: input.exitCode,
    signal: input.signal,
    terminationReason: state.cancelled
      ? "cancelled"
      : state.error
        ? `session_error:${state.error.type ?? "unknown"}`
        : state.result
          ? state.result.exitCode === 0
            ? "completed"
            : `exit_${state.result.exitCode}`
          : null,
    error: input.error,
    resultText: state.lastAssistantText,
    numTurns: null,
    toolCalls: state.toolCalls,
    usage: sumUsage(usageByModel),
    usageByModel,
    // Copilot bills premium requests, never dollars: every run is unpriced (budgets count its cap).
    costUsd: null,
    permissionDenials: state.permissionDenials,
    deniedTools: state.deniedTools,
    contextExhausted: false,
    sessionNotFound: input.sessionNotFound,
    // Only the error text of a failed run is classified; no fixture shows a rate limit yet.
    failure: classifyFailure({
      outcome: input.outcome,
      error: input.outcome === "failed" ? input.error : null,
      terminalReason: null,
      subtype: null,
      stopReason: null,
      endedAt: input.endedAt,
    }),
    rawResult: state.result || input.usageFile ? { result: state.result?.raw ?? null, usage: input.usageFile } : null,
    subagents: [],
  };
}

/**
 * The `copilot` binary, first match wins: the `COPILOT_BIN` environment variable (as `CLAUDE_BIN`
 * for Claude: the tests point it at fake-copilot.js so the real CLI is never launched), then
 * `copilot.binary`, then `copilot` on the effective PATH. A path that does not exist is null.
 */
export function resolveCopilotBinary(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env["COPILOT_BIN"];
  if (override) return existsSync(override) ? override : null;
  if (configured) return existsSync(configured) ? configured : null;
  // Windows: a native copilot.exe first, then npm's copilot.cmd shim (spawned through cmd.exe, win-cmd.ts).
  const names = process.platform === "win32" ? ["copilot.exe", "copilot.cmd"] : ["copilot"];
  for (const dir of effectivePath(env["PATH"]).split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function copilotNotFound(configured: string | null): string {
  if (process.env["COPILOT_BIN"]) return `GitHub Copilot CLI not found at COPILOT_BIN (${process.env["COPILOT_BIN"]})`;
  return configured
    ? `GitHub Copilot CLI not found at copilot.binary (${configured})`
    : "GitHub Copilot CLI not found on PATH; set copilot.binary in duskfleet.yaml";
}
