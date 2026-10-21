/**
 * Claude Code CLI executor.
 *
 * Everything CLI-specific lives here: flag names, output parsing, process
 * lifecycle. The rest of DuskFleet only sees `Executor` / `ExecutionResult`.
 *
 * Flags used were verified against `claude --help` for 2.1.285.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { classifyFailure } from "../observability/failure.js";
import type { BillingType, RecordedCommand } from "../observability/run.js";
import { logger } from "../util/log.js";
import { missingMcpServers } from "./mcp.js";
import { createStreamState, ingestLine, looksLikeContextExhaustion } from "./stream-json.js";
import {
  type ExecutionEvent,
  type ExecutionHandle,
  type ExecutionRequest,
  type ExecutionResult,
  type Executor,
  MIXED_MODEL,
} from "./types.js";

const log = logger("execution");

export interface ClaudeCodeExecutorOptions {
  /** Explicit binary path; when null the executor resolves it. */
  binary: string | null;
  strictMcpConfig: boolean;
  /** When set, passed as --setting-sources <a,b>. Lets unattended runs skip user-level hooks/settings. */
  settingSources?: string[] | null;
  /** Only when true will bypassPermissions be translated into --dangerously-skip-permissions. */
  allowBypassPermissions: boolean;
  /**
   * How long the process group may outlive the `result` line before it is sent SIGTERM
   * (then SIGKILL after the kill grace). Default 5 s; tests shorten it.
   */
  resultGraceMs?: number;
}

/** Grace period between SIGTERM and SIGKILL when cancelling or timing out. */
const KILL_GRACE_MS = 5_000;
/** Default time the child may keep running (or keep its stdio open) after printing its result. */
const RESULT_GRACE_MS = 5_000;
/**
 * The child leads its own process group, so a signal reaches what it spawned too (hooks,
 * shells) and a grandchild holding stdout open cannot keep the run alive. Windows has no
 * process groups (and `detached` would open a console there).
 */
const OWN_PROCESS_GROUP = process.platform !== "win32";
/** Resolution of a process ended at its init line because a required MCP server was absent. */
const RESTART = Symbol("restart");

export class ClaudeCodeExecutor implements Executor {
  readonly name = "claude-code";
  readonly binary: string;

  constructor(private readonly options: ClaudeCodeExecutorOptions) {
    this.binary = resolveClaudeBinary(options.binary);
  }

  version(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, ["--version"], { timeout: 15_000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
    });
  }

  buildArgv(req: ExecutionRequest): string[] {
    const argv: string[] = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose", // required by --output-format stream-json in print mode (verified)
      // A fresh session gets the id we chose; a wrap-up pass continues the one that ran out
      // of budget (`-r, --resume <session-id>`, verified against claude --help 2.1.299).
      ...(req.resumeSessionId ? ["--resume", req.resumeSessionId] : ["--session-id", req.sessionId]),
      "--permission-mode",
      req.permissionMode,
      "--permission-prompts",
      "none", // unattended: never block on a prompt; denials are recorded instead
    ];
    if (req.permissionMode === "bypassPermissions") {
      if (!this.options.allowBypassPermissions) {
        throw new Error(
          "permission_mode bypassPermissions is disabled. Set claude.allow_bypass_permissions: true in duskfleet.yaml to enable it.",
        );
      }
      // Verified against claude --help 2.1.295: --permission-prompts none "refuses bypassPermissions".
      // Unattended runs therefore cannot use it; fail here with a clear message instead of a dead run.
      throw new Error(
        "permission_mode bypassPermissions cannot be used in unattended runs: Claude Code refuses it together with --permission-prompts none. Use dontAsk with an allowed_tools list instead.",
      );
    }
    // Default: no MCP at all (fast, no recursion into DuskFleet). Opt in per agent/project.
    if (this.options.strictMcpConfig && !req.inheritMcp) argv.push("--strict-mcp-config");
    for (const dir of req.addDirs ?? []) argv.push("--add-dir", dir);
    if (req.claudeAgent) argv.push("--agent", req.claudeAgent);
    if (this.options.settingSources && this.options.settingSources.length > 0) {
      argv.push("--setting-sources", this.options.settingSources.join(","));
    }
    if (req.model) argv.push("--model", req.model);
    if (req.effort) argv.push("--effort", req.effort);
    if (req.maxBudgetUsd !== undefined) argv.push("--max-budget-usd", String(req.maxBudgetUsd));
    if (req.allowedTools?.length) argv.push("--allowedTools", ...req.allowedTools);
    if (req.disallowedTools?.length) argv.push("--disallowedTools", ...req.disallowedTools);
    if (req.appendSystemPrompt) argv.push("--append-system-prompt", req.appendSystemPrompt);
    // No positional prompt: `execute` writes it on stdin (`-p` reads the prompt from stdin when
    // none is given; `--input-format` defaults to text, verified against claude --help 2.1.3xx).
    // The prompt therefore stays out of `ps` output and of the recorded command.
    return argv;
  }

  execute(req: ExecutionRequest, onEvent?: (event: ExecutionEvent) => void): ExecutionHandle {
    const argv = this.buildArgv(req);
    const command: RecordedCommand = { binary: this.binary, argv, cwd: req.cwd };
    const emit = (e: ExecutionEvent) => {
      try {
        onEvent?.(e);
      } catch (err) {
        log.warn("event handler threw", { err: String(err) });
      }
    };

    const startedAt = new Date();
    let outcome: ExecutionResult["outcome"] | null = null; // set by cancel/timeout before exit
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let closed = false; // stdio closed and the process exited: nothing left to signal
    let child: ChildProcess | null = null; // the process running now (a restart replaces it)
    let restartInfo: { missing: string[]; mounted: string[] } | null = null;
    let logStream: WriteStream | null = null;

    if (req.logPath) {
      mkdirSync(path.dirname(req.logPath), { recursive: true });
      logStream = createWriteStream(req.logPath, { flags: "a" });
      logStream.on("error", (err) => log.warn("log file write failed", { path: req.logPath, err: err.message }));
      // Lines starting with # are not stream-json (see #stderr below); this one marks where a resumed pass begins.
      if (req.resumeSessionId) logStream.write(`#resume ${req.resumeSessionId} ${startedAt.toISOString()}\n`);
    }

    const env = childEnv();
    const billingType = billingTypeOf(env);
    const required = req.resumeSessionId ? [] : (req.requiredMcpServers ?? []);
    const resultGraceMs = this.options.resultGraceMs ?? RESULT_GRACE_MS;

    /** Signal the current child's whole process group (the child alone where there are no groups). */
    const signal = (sig: NodeJS.Signals) => {
      if (!child) return;
      if (OWN_PROCESS_GROUP && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // ESRCH: the group is gone already; fall through to the child itself.
        }
      }
      child.kill(sig);
    };

    /** SIGTERM the group now, SIGKILL it if it is still there after the grace. */
    const endGroup = () => {
      signal("SIGTERM");
      killTimer = setTimeout(() => {
        if (!closed) signal("SIGKILL");
      }, KILL_GRACE_MS);
    };

    const terminate = (reason: ExecutionResult["outcome"]) => {
      if (outcome || closed) return;
      outcome = reason;
      log.info(`terminating run (${reason})`, { pid: child?.pid });
      endGroup();
    };

    /**
     * One process. Resolves with its result, or with RESTART when its `init` line lacked a
     * required MCP server and the caller should spawn again (only offered to the first
     * attempt; a second init is taken as it comes).
     */
    const attempt = (sessionId: string, attemptArgv: string[], mayRestart: boolean) => {
      const proc = spawn(this.binary, attemptArgv, {
        cwd: req.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"], // stdin carries the prompt, never argv
        shell: false, // never a shell: argv is passed verbatim to the binary
        detached: OWN_PROCESS_GROUP,
      });
      child = proc;
      // The prompt goes on stdin, then EOF. A child that exits (or fails to spawn) before reading
      // it closes the pipe: EPIPE is expected there and the exit path reports the real outcome.
      proc.stdin!.on("error", (err) => log.debug("stdin write failed", { pid: proc.pid, err: err.message }));
      proc.stdin!.end(req.prompt, "utf8");
      closed = false;
      const state = createStreamState();
      let resultTimer: NodeJS.Timeout | null = null;
      let graceKilled = false; // ended by DuskFleet after a result line: the result decides the outcome
      let restart = false; // ended by DuskFleet at its init line: the next process decides
      let stderrTail = "";
      let spawnError: string | null = null;

      /**
       * The result line is the end of the run. A child that is still running (or whose
       * descendants, such as a user-level Stop hook, still hold its stdout) once the grace
       * is over would hang the run until its timeout: end the group instead.
       */
      const graceKill = () => {
        resultTimer = null;
        if (closed || outcome || graceKilled || restart) return;
        graceKilled = true;
        const childAlive = proc.exitCode === null && proc.signalCode === null;
        log.warn("process still running after its result line; ending its process group", {
          pid: proc.pid,
          childAlive,
        });
        emit({ type: "grace_kill", pid: proc.pid ?? null, afterMs: resultGraceMs, childAlive });
        endGroup();
      };

      const done = new Promise<ExecutionResult | typeof RESTART>((resolve) => {
        const stdout = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
        stdout.on("line", (line) => {
          logStream?.write(line + "\n");
          for (const ev of ingestLine(state, line)) {
            emit(ev);
            if (ev.type !== "init" || !mayRestart || restart || outcome) continue;
            const missing = missingMcpServers(required, ev.mcpServers);
            if (missing.length === 0) continue;
            // Before the first model turn: end this process and start over with a fresh session.
            restart = true;
            restartInfo = { missing, mounted: ev.mcpServers.map((s) => s.name) };
            log.warn("init reported no server for a required MCP prefix; restarting the process", {
              pid: proc.pid,
              missing,
              mounted: ev.mcpServers.map((s) => s.name),
            });
            logStream?.write(`#restart ${missing.join(",")} ${new Date().toISOString()}\n`);
            endGroup();
          }
          if (state.result && !resultTimer && !graceKilled && !closed && !restart) {
            resultTimer = setTimeout(graceKill, resultGraceMs);
          }
        });

        proc.stderr!.setEncoding("utf8");
        proc.stderr!.on("data", (chunk: string) => {
          stderrTail = (stderrTail + chunk).slice(-4000);
          logStream?.write(`#stderr ${chunk.replace(/\n(?!$)/g, "\n#stderr ")}`);
          emit({ type: "stderr", text: chunk });
        });

        proc.on("error", (err) => {
          spawnError = err.message;
        });

        proc.on("close", (code, signal) => {
          closed = true;
          if (killTimer) clearTimeout(killTimer);
          if (resultTimer) clearTimeout(resultTimer);
          const endedAt = new Date();

          if (restart && !outcome) {
            resolve(RESTART);
            return;
          }
          let error: string | null = null;
          let finalOutcome: ExecutionResult["outcome"];
          if (outcome) {
            finalOutcome = outcome;
          } else if (spawnError) {
            finalOutcome = "failed";
            error = spawnError;
          } else if (!state.result) {
            finalOutcome = "failed";
            error =
              `no result message received (exit ${code ?? "null"}, signal ${signal ?? "none"})` + tail(stderrTail);
          } else if (state.result.isError || (!graceKilled && code !== null && code !== 0)) {
            // After a grace kill the exit code is the signal's (143, 1...), not the run's verdict.
            finalOutcome = "failed";
            // A budget stop has no `result` text, only `errors: ["Reached maximum budget ($5)"]`.
            error = state.result.resultText ?? state.result.errorText ?? `exit code ${code}` + tail(stderrTail);
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
              signal,
              state,
              sessionId,
            }),
          );
        });
      });
      return { proc, done };
    };

    const spawnFailed = (err: unknown): ExecutionResult =>
      finalResult({
        outcome: "failed",
        error: `spawn failed: ${String(err)}`,
        startedAt,
        endedAt: new Date(),
        exitCode: null,
        signal: null,
        state: createStreamState(),
        sessionId: req.sessionId,
      });

    let first: ReturnType<typeof attempt>;
    try {
      first = attempt(req.sessionId, argv, required.length > 0);
    } catch (err) {
      logStream?.end();
      return { command, pid: null, billingType, cancel: () => {}, done: Promise.resolve(spawnFailed(err)) };
    }

    if (req.timeoutMs && req.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate("timed_out"), req.timeoutMs);
    }

    const done = first.done
      .then((result) => {
        if (result !== RESTART) return result;
        if (outcome) {
          // Cancelled or timed out while the first process was going down: nothing to restart.
          return finalResult({
            outcome,
            error: null,
            startedAt,
            endedAt: new Date(),
            exitCode: null,
            signal: null,
            state: createStreamState(),
            sessionId: req.sessionId,
          });
        }
        // A new id: the first process may have written its session file already.
        const sessionId = randomUUID();
        let second: ReturnType<typeof attempt>;
        try {
          second = attempt(sessionId, this.buildArgv({ ...req, sessionId }), false);
        } catch (err) {
          return spawnFailed(err);
        }
        emit({
          type: "mcp_restart",
          missing: restartInfo?.missing ?? required,
          mounted: restartInfo?.mounted ?? [],
          pid: second.proc.pid ?? null,
          sessionId,
        });
        return second.done.then((r) => (r === RESTART ? spawnFailed("restart offered twice") : r));
      })
      .finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        logStream?.end();
      });

    return {
      command,
      pid: first.proc.pid ?? null,
      billingType,
      done,
      cancel: () => terminate("cancelled"),
    };
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
  state: ReturnType<typeof createStreamState>;
  sessionId: string;
}): ExecutionResult {
  const r = input.state.result;
  return {
    outcome: input.outcome,
    sessionId: input.state.sessionId ?? input.sessionId,
    // Tokens spent on several models (subagents) make the run "mixed"; otherwise the main session's model.
    model: r?.modelUsed === MIXED_MODEL ? MIXED_MODEL : (input.state.model ?? r?.modelUsed ?? null),
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    exitCode: input.exitCode,
    signal: input.signal,
    terminationReason: r ? (r.terminalReason ?? r.subtype) : null,
    error: input.error,
    resultText: r?.resultText ?? input.state.lastAssistantText,
    numTurns: r?.numTurns ?? null,
    toolCalls: input.state.toolCalls,
    usage: r?.usage ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    usageByModel: r?.usageByModel ?? null,
    costUsd: r?.costUsd ?? null,
    permissionDenials: r?.permissionDenials ?? 0,
    deniedTools: r?.deniedTools ?? [],
    contextExhausted: looksLikeContextExhaustion(r),
    failure: classifyFailure({
      outcome: input.outcome,
      // A result line with is_error false carries the agent's prose even when the exit code is
      // non-zero: never scan it ("the 503 retry test now passes" is not an outage).
      error: !r || r.isError ? input.error : null,
      terminalReason: r?.terminalReason ?? null,
      subtype: r?.subtype ?? null,
      stopReason: r?.stopReason ?? null,
      endedAt: input.endedAt,
    }),
    rawResult: r?.raw ?? null,
    subagents: [...input.state.subagents.values()],
  };
}

/**
 * Environment for the child. Starts from ours (so auth, PATH and HOME work)
 * and removes markers that make Claude Code believe it is nested inside
 * another Claude Code session.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key === "CLAUDE_CODE_ENTRYPOINT" || key.startsWith("CLAUDE_CODE_SSE_")) delete env[key];
  }
  // DuskFleet's own variable: an agent running `npm test` here would launch the real claude.
  delete env["CLAUDE_BIN"];
  return env;
}

/**
 * `api` when the child gets an `ANTHROPIC_API_KEY` (Claude Code then bills that key per token),
 * `subscription` otherwise (the reported cost is an estimate, not billed).
 */
export function billingTypeOf(env: NodeJS.ProcessEnv): BillingType {
  return env["ANTHROPIC_API_KEY"]?.trim() ? "api" : "subscription";
}

/**
 * Binary resolution order:
 *   1. CLAUDE_BIN environment variable
 *   2. explicit config value
 *   3. `claude` found on PATH
 *   4. ~/.local/bin/claude (default install location)
 */
export function resolveClaudeBinary(configured: string | null): string {
  const candidates: string[] = [];
  if (process.env["CLAUDE_BIN"]) candidates.push(process.env["CLAUDE_BIN"]);
  if (configured) candidates.push(configured);
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "claude"));
  }
  candidates.push(path.join(homedir(), ".local", "bin", "claude"));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Claude Code binary not found. Tried: ${candidates.slice(0, 3).join(", ")}, PATH, ~/.local/bin/claude. ` +
      `Set claude.binary in duskfleet.yaml or the CLAUDE_BIN environment variable.`,
  );
}
