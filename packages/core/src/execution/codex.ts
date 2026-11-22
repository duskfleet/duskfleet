/**
 * Codex CLI executor (`harness: codex`, issue #50, docs/harnesses.md).
 *
 * Flags verified by hand against `codex exec --help` and real runs of codex-cli 0.167.1 (fixtures
 * in `packages/mcp/test/fixtures/codex/`). What the adapter does with them:
 *
 * - `codex exec --json`, the prompt on stdin with `-` as the prompt argument (it stays out of argv
 *   and `ps`; with a prompt argument piped stdin would be appended to it);
 * - `--ignore-user-config` (the user's `config.toml`: default model, `notify` program, trusted
 *   projects, MCP servers, never reach a run; auth still comes from `CODEX_HOME`) and
 *   `--ignore-rules` (no user or project execpolicy `.rules` file);
 * - Codex has no tool allow-list, only a sandbox: `dontAsk` = `-s read-only`, `acceptEdits` =
 *   `-s workspace-write`, and the network off (`-c sandbox_workspace_write.network_access=false`)
 *   unless the agent opts in with `codex_network: true` (issue #488, `acceptEdits` only: `=true`);
 * - `-m <model>`, `-c model_reasoning_effort="<effort>"`;
 * - the agent body as `-c developer_instructions="<TOML string>"` (no file to write).
 *
 * Never passed: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
 * `-s danger-full-access`. Codex picks the session id itself (`thread.started`).
 *
 * Resuming (issue #485, verified by hand on codex-cli 0.167.1): `codex exec resume` has no `-s`, but
 * `-c sandbox_mode="<mode>"` decides the sandbox of the resumed turn whatever the base session used,
 * so a resume always carries it, from the agent's `permission_mode` (never the resume form without
 * it). The thread id is the last argument before `-`; Codex reports the same id in `thread.started`.
 * An unknown thread prints nothing on stdout and a `no rollout found` line on stderr
 * (`isCodexSessionNotFound`): the result says `sessionNotFound`, the run path starts fresh.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { classifyFailure } from "../observability/failure.js";
import type { RecordedCommand } from "../observability/run.js";
import { logger } from "../util/log.js";
import { childEnv } from "./child-env.js";
import { type CodexStreamState, createCodexState, ingestCodexLine, isCodexSessionNotFound } from "./codex-jsonl.js";
import { CODEX_CAPABILITIES, CODEX_HARNESS } from "./harness.js";
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

export interface CodexExecutorOptions {
  /** `codex.binary` from duskfleet.yaml; null = `codex` on PATH. */
  binary: string | null;
  /** `claude.env_passthrough`, for `codex --version` (a run gets its own list in the request). */
  envPassthrough?: string[];
  /** How long the process group may outlive the terminal turn event before it is ended. Default 5 s. */
  resultGraceMs?: number;
  /** A run with no stdout line for this long is ended `timed_out`. Default 30 min. */
  inactivityMs?: number;
}

/** The sandbox each accepted `permission_mode` runs under. */
export const CODEX_SANDBOX_BY_MODE = Object.freeze({ dontAsk: "read-only", acceptEdits: "workspace-write" } as const);

/** The note a networked Codex run records at start. */
export const CODEX_NETWORK_NOTE =
  "network on (codex_network: true): -c sandbox_workspace_write.network_access=true, every host, with the credentials of the user who runs Duskfleet";

/** The `-c` value of the network switch: off unless the agent opted in. */
function networkAccess(req: ExecutionRequest): string {
  return `sandbox_workspace_write.network_access=${req.network ? "true" : "false"}`;
}
const KILL_GRACE_MS = 5_000;
const RESULT_GRACE_MS = 5_000;
/** Backstop only: a run ends on its own `turn.completed` / `turn.failed`. */
const INACTIVITY_MS = 30 * 60_000;
const OWN_PROCESS_GROUP = process.platform !== "win32";

export class CodexExecutor implements Executor {
  readonly name = "codex-cli";
  readonly harness = CODEX_HARNESS;
  readonly capabilities = CODEX_CAPABILITIES;
  readonly binary: string;

  /** Throws when no binary is found; `resolveCodexBinary` tells beforehand. */
  constructor(private readonly options: CodexExecutorOptions) {
    const binary = resolveCodexBinary(options.binary);
    if (!binary) throw new Error(codexNotFound(options.binary));
    this.binary = binary;
  }

  /** The capability check refuses these fields first; a request built elsewhere must not slip through. */
  prepare(request: ExecutionRequest): PrepareResult {
    if (request.allowedTools?.length) throw new Error("allowed_tools is not supported by harness codex");
    if (request.disallowedTools?.length) throw new Error("disallowed_tools is not supported by harness codex");
    if (request.addDirs?.length) throw new Error("add_dirs is not supported by harness codex");
    if (request.inheritMcp) throw new Error("inherit_mcp is not supported by harness codex");
    if (request.claudeAgent) throw new Error("claude_agent is not supported by harness codex");
    if (request.sandbox) throw new Error("sandbox is not supported by harness codex");
    if (!request.network) return { notes: [] };
    if (CODEX_SANDBOX_BY_MODE[request.permissionMode as keyof typeof CODEX_SANDBOX_BY_MODE] !== "workspace-write")
      throw new Error("codex_network needs permission_mode acceptEdits on harness codex");
    return { notes: [CODEX_NETWORK_NOTE] };
  }

  version(): Promise<string> {
    const plan = spawnPlan(this.binary, ["--version"]);
    return new Promise((resolve, reject) => {
      execFile(
        plan.file,
        plan.args,
        {
          timeout: 15_000,
          env: childEnv(this.options.envPassthrough),
          windowsVerbatimArguments: plan.windowsVerbatimArguments,
        },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
  }

  /** argv for one run; the prompt goes on stdin. */
  buildArgv(req: ExecutionRequest): string[] {
    const sandbox = (CODEX_SANDBOX_BY_MODE as Record<string, string>)[req.permissionMode];
    if (!sandbox) throw new Error(`permission_mode ${req.permissionMode} is not supported by harness codex`);
    // Never the network on a read-only sandbox (#488): prepare and the harness check refuse it first.
    if (req.network && sandbox !== "workspace-write")
      throw new Error("codex_network needs permission_mode acceptEdits on harness codex");
    if (req.resumeSessionId) {
      // The verified resume form: the sandbox as a config override (resume has no `-s`), always.
      // No `-m`: the model flag was not part of the verified command.
      const argv = [
        "exec",
        "resume",
        "--json",
        "--ignore-user-config",
        "--ignore-rules",
        "-c",
        `sandbox_mode=${tomlString(sandbox)}`,
        "-c",
        networkAccess(req),
      ];
      if (req.effort) argv.push("-c", `model_reasoning_effort=${tomlString(req.effort)}`);
      // The same value as a fresh run; whether it replaces or adds to the base session's is unverified.
      if (req.appendSystemPrompt) argv.push("-c", `developer_instructions=${tomlString(req.appendSystemPrompt)}`);
      argv.push(req.resumeSessionId, "-");
      return argv;
    }
    const argv = ["exec", "--json", "--ignore-user-config", "--ignore-rules", "-s", sandbox, "-c", networkAccess(req)];
    if (req.model) argv.push("-m", req.model);
    if (req.effort) argv.push("-c", `model_reasoning_effort=${tomlString(req.effort)}`);
    if (req.appendSystemPrompt) argv.push("-c", `developer_instructions=${tomlString(req.appendSystemPrompt)}`);
    argv.push("-");
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
    const argv = this.buildArgv(req);
    const command: RecordedCommand = { binary: this.binary, argv, cwd: req.cwd };

    let logStream: CappedLogWriter | null = null;
    if (req.logPath) {
      logStream = new CappedLogWriter(req.logPath, req.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, (err) =>
        log.warn("log file write failed", { path: req.logPath, err: err.message }),
      );
    }

    const state = createCodexState();
    let outcome: ExecutionResult["outcome"] | null = null; // set by cancel / timeout
    let inactive = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let resultTimer: NodeJS.Timeout | null = null;
    let inactivityTimer: NodeJS.Timeout | null = null;
    let graceKilled = false;
    let stderrTail = "";
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
      // A Windows `codex.cmd` shim needs cmd.exe (Node refuses a batch file without it): win-cmd.ts.
      const plan = spawnPlan(this.binary, argv);
      child = spawn(plan.file, plan.args, {
        cwd: req.cwd,
        env: childEnv(req.envPassthrough),
        stdio: ["pipe", "pipe", "pipe"], // stdin carries the prompt, never argv
        shell: false,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: OWN_PROCESS_GROUP,
      });
    } catch (err) {
      const ended = logStream?.end() ?? Promise.resolve();
      const result = finalResult({
        outcome: "failed",
        error: `spawn failed: ${String(err)}`,
        startedAt,
        endedAt: new Date(),
        exitCode: null,
        signal: null,
        state,
        sessionId: req.resumeSessionId ?? req.sessionId,
        model: req.resumeSessionId ? null : (req.model ?? null),
        sessionNotFound: false,
      });
      return { command, pid: null, cancel: () => {}, done: ended.then(() => result) };
    }
    child.stdin!.on("error", (err) => log.debug("stdin write failed", { pid: child.pid, err: err.message }));
    child.stdin!.end(req.prompt, "utf8");

    const resultGraceMs = this.options.resultGraceMs ?? RESULT_GRACE_MS;
    const inactivityMs = this.options.inactivityMs ?? INACTIVITY_MS;
    const graceKill = () => {
      resultTimer = null;
      if (closed || outcome || graceKilled) return;
      graceKilled = true;
      const childAlive = child.exitCode === null && child.signalCode === null;
      log.warn("process still running after its terminal turn event; ending its process group", { pid: child.pid });
      emit({ type: "grace_kill", pid: child.pid ?? null, afterMs: resultGraceMs, childAlive });
      endGroup();
    };
    const armInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (closed || state.turnEnd) return;
      inactivityTimer = setTimeout(() => {
        if (closed || outcome) return;
        inactive = true;
        terminate("timed_out");
      }, inactivityMs);
    };
    armInactivity();

    const done = new Promise<ExecutionResult>((resolve) => {
      const stdout = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
      stdout.on("line", (line) => {
        logStream?.write(`${line}\n`);
        for (const ev of ingestCodexLine(state, line)) emit(ev);
        armInactivity();
        if (state.turnEnd && !resultTimer && !graceKilled && !closed)
          resultTimer = setTimeout(graceKill, resultGraceMs);
      });

      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        const window = stderrTail + chunk; // the tail before the cut: a line split across chunks still matches
        if (req.resumeSessionId && !stderrSessionNotFound && isCodexSessionNotFound(0, window))
          stderrSessionNotFound = true;
        stderrTail = window.slice(-4000);
        logStream?.write(`#stderr ${chunk.replace(/\n(?!$)/g, "\n#stderr ")}`);
        emit({ type: "stderr", text: chunk });
      });
      child.on("error", (err) => {
        spawnError = err.message;
      });

      child.on("close", (code, sig) => {
        closed = true;
        for (const t of [killTimer, resultTimer, timeoutTimer, inactivityTimer]) if (t) clearTimeout(t);
        const endedAt = new Date();
        const sessionNotFound = !!req.resumeSessionId && state.lines === 0 && stderrSessionNotFound;
        let error: string | null = null;
        let finalOutcome: ExecutionResult["outcome"];
        if (outcome) {
          finalOutcome = outcome;
          if (inactive) {
            const span =
              inactivityMs >= 60_000
                ? `${Math.round(inactivityMs / 60_000)} min`
                : `${Math.ceil(inactivityMs / 1000)} s`;
            error = `no output from codex for ${span}; the run was ended`;
          }
        } else if (spawnError) {
          finalOutcome = "failed";
          error = spawnError;
        } else if (!state.turnEnd) {
          finalOutcome = "failed";
          error = `no turn.completed line received (exit ${code ?? "null"}, signal ${sig ?? "none"})${tail(stderrTail)}`;
        } else if (state.turnEnd.kind === "failed") {
          finalOutcome = "failed";
          error = state.turnEnd.error;
        } else if (!graceKilled && code !== null && code !== 0) {
          finalOutcome = "failed";
          error = `exit code ${code}${tail(stderrTail)}`;
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
            model: req.resumeSessionId ? null : (req.model ?? null),
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
 * A TOML basic string (`-c` values are parsed as TOML): quotes, backslashes and every control
 * character escaped, so a multi-line agent body is one argv entry without a raw newline.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function tail(stderr: string): string {
  // Printed by every run whose stdin is not a terminal (fixtures README): not an error.
  const t = stderr.replace(/^Reading additional input from stdin\.\.\.\n?/gm, "").trim();
  return t ? `\nstderr: ${t.slice(-1000)}` : "";
}

function finalResult(input: {
  outcome: ExecutionResult["outcome"];
  error: string | null;
  startedAt: Date;
  endedAt: Date;
  exitCode: number | null;
  signal: string | null;
  state: CodexStreamState;
  sessionId: string;
  model: string | null;
  sessionNotFound: boolean;
}): ExecutionResult {
  const { state } = input;
  return {
    outcome: input.outcome,
    // Codex picks its own thread id; the caller's id stands only when the stream never started.
    sessionId: state.threadId ?? input.sessionId,
    // The stream never names the model: the one asked for, else unknown (the CLI's default).
    model: input.model,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    exitCode: input.exitCode,
    signal: input.signal,
    terminationReason:
      input.outcome === "cancelled"
        ? "cancelled"
        : state.turnEnd
          ? `turn_${state.turnEnd.kind}`
          : input.exitCode !== null
            ? `exit_${input.exitCode}`
            : null,
    error: input.error,
    resultText: state.lastAssistantText,
    numTurns: null,
    toolCalls: state.toolCalls,
    usage: state.usage,
    usageByModel: null,
    // The stream reports no cost (a ChatGPT plan or API key alike): every run is unpriced.
    costUsd: null,
    permissionDenials: 0,
    deniedTools: [],
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
    rawResult: state.turnEnd?.raw ?? null,
    subagents: [],
  };
}

/**
 * The `codex` binary, first match wins: the `CODEX_BIN` environment variable (the tests point it
 * at fake-codex.js so the real CLI is never launched), then `codex.binary`, then `codex` on the
 * effective PATH. A path that does not exist is null.
 */
export function resolveCodexBinary(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env["CODEX_BIN"];
  if (override) return existsSync(override) ? override : null;
  if (configured) return existsSync(configured) ? configured : null;
  // Windows: a native codex.exe first, then npm's codex.cmd shim (spawned through cmd.exe, win-cmd.ts).
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const dir of effectivePath(env["PATH"]).split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function codexNotFound(configured: string | null): string {
  if (process.env["CODEX_BIN"]) return `Codex CLI not found at CODEX_BIN (${process.env["CODEX_BIN"]})`;
  return configured
    ? `Codex CLI not found at codex.binary (${configured})`
    : "Codex CLI not found on PATH; set codex.binary in duskfleet.yaml";
}
