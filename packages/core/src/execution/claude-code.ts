/**
 * Claude Code CLI executor.
 *
 * Everything CLI-specific lives here: flag names, output parsing, process
 * lifecycle. The rest of DuskFleet only sees `Executor` / `ExecutionResult`.
 *
 * Flags used were verified against `claude --help` for 2.1.285.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RecordedCommand } from "../observability/run.js";
import { logger } from "../util/log.js";
import { createStreamState, ingestLine, looksLikeContextExhaustion } from "./stream-json.js";
import type { ExecutionEvent, ExecutionHandle, ExecutionRequest, ExecutionResult, Executor } from "./types.js";

const log = logger("execution");

export interface ClaudeCodeExecutorOptions {
  /** Explicit binary path; when null the executor resolves it. */
  binary: string | null;
  strictMcpConfig: boolean;
  /** When set, passed as --setting-sources <a,b>. Lets unattended runs skip user-level hooks/settings. */
  settingSources?: string[] | null;
  /** Only when true will bypassPermissions be translated into --dangerously-skip-permissions. */
  allowBypassPermissions: boolean;
}

/** Grace period between SIGTERM and SIGKILL when cancelling or timing out. */
const KILL_GRACE_MS = 5_000;

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
      "--session-id",
      req.sessionId,
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
    // The prompt is the final positional argument. `--` guards against prompts
    // that begin with a dash being parsed as flags.
    argv.push("--", req.prompt);
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
    const state = createStreamState();
    let outcome: ExecutionResult["outcome"] | null = null; // set by cancel/timeout before exit
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let stderrTail = "";
    let logStream: WriteStream | null = null;

    if (req.logPath) {
      mkdirSync(path.dirname(req.logPath), { recursive: true });
      logStream = createWriteStream(req.logPath, { flags: "a" });
      logStream.on("error", (err) => log.warn("log file write failed", { path: req.logPath, err: err.message }));
    }

    let child: ChildProcess;
    try {
      child = spawn(this.binary, argv, {
        cwd: req.cwd,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false, // never a shell: argv is passed verbatim to the binary
      });
    } catch (err) {
      logStream?.end();
      const endedAt = new Date();
      return {
        command,
        pid: null,
        cancel: () => {},
        done: Promise.resolve(
          finalResult({
            outcome: "failed",
            error: `spawn failed: ${String(err)}`,
            startedAt,
            endedAt,
            exitCode: null,
            signal: null,
            state,
            sessionId: req.sessionId,
          }),
        ),
      };
    }

    const terminate = (reason: ExecutionResult["outcome"]) => {
      if (outcome || child.exitCode !== null) return;
      outcome = reason;
      log.info(`terminating run (${reason})`, { pid: child.pid });
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };

    if (req.timeoutMs && req.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => terminate("timed_out"), req.timeoutMs);
    }

    const done = new Promise<ExecutionResult>((resolve) => {
      let spawnError: string | null = null;

      const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      stdout.on("line", (line) => {
        logStream?.write(line + "\n");
        for (const ev of ingestLine(state, line)) emit(ev);
      });

      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-4000);
        logStream?.write(`#stderr ${chunk.replace(/\n(?!$)/g, "\n#stderr ")}`);
        emit({ type: "stderr", text: chunk });
      });

      child.on("error", (err) => {
        spawnError = err.message;
      });

      child.on("close", (code, signal) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        logStream?.end();
        const endedAt = new Date();

        let error: string | null = null;
        let finalOutcome: ExecutionResult["outcome"];
        if (outcome) {
          finalOutcome = outcome;
        } else if (spawnError) {
          finalOutcome = "failed";
          error = spawnError;
        } else if (!state.result) {
          finalOutcome = "failed";
          error = `no result message received (exit ${code ?? "null"}, signal ${signal ?? "none"})` + tail(stderrTail);
        } else if (state.result.isError || (code !== null && code !== 0)) {
          finalOutcome = "failed";
          error = state.result.resultText ?? `exit code ${code}` + tail(stderrTail);
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
            sessionId: req.sessionId,
          }),
        );
      });
    });

    return {
      command,
      pid: child.pid ?? null,
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
    model: input.state.model ?? r?.modelUsed ?? null,
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
    costUsd: r?.costUsd ?? null,
    permissionDenials: r?.permissionDenials ?? 0,
    deniedTools: r?.deniedTools ?? [],
    contextExhausted: looksLikeContextExhaustion(r),
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
  return env;
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
