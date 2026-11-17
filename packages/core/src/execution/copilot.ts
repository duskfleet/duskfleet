/**
 * GitHub Copilot CLI executor (`harness: copilot`, issue #446, docs/harnesses.md).
 *
 * Flags verified against `copilot --help` and real runs of Copilot CLI 1.0.112 (fixtures in
 * `packages/mcp/test/fixtures/copilot/`). What the adapter does with them:
 *
 * - the prompt goes on stdin (no `-p`: same stream, the prompt stays out of argv and `ps`);
 * - `--output-format json` (JSONL), `--no-ask-user`, `--no-auto-update` (a run must not change the
 *   CLI under it), `--disable-builtin-mcps` (runs are strict-MCP), always;
 * - `--session-id <uuid>` for a fresh session, `--resume=<id>` to continue one;
 * - `allowed_tools` / `disallowed_tools` hold Copilot's own rules, passed verbatim to
 *   `--allow-tool` / `--deny-tool` (copilot-rules.ts); `acceptEdits` adds `--allow-tool write`.
 *   In a non-interactive run a permission request that would prompt is denied: deny by default;
 * - the agent's system prompt becomes a Copilot agent file in a per-run temp directory, passed
 *   with `--add-dir <tmp> --agent <name>` (there is no system prompt flag, and
 *   `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` is not applied in an untrusted folder);
 * - `--usage-output-file` into the same temp directory: tokens per model for the result.
 *
 * Never passed: `--trust-folder`, `--allow-all-tools`, `--allow-all`, `--yolo`, `--autopilot`;
 * `COPILOT_ALLOW_ALL` never reaches the child, even through an `env_passthrough`.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
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
import { COPILOT_CAPABILITIES, COPILOT_HARNESS } from "./harness.js";
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
    if (request.claudeAgent) throw new Error("claude_agent is not supported by harness copilot");
    if (request.sandbox) throw new Error("sandbox is not supported by harness copilot");
    return { notes: [] };
  }

  version(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        ["--version"],
        { timeout: 15_000, env: copilotEnv(this.options.envPassthrough) },
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
    const argv = [
      "--output-format",
      "json",
      "--no-ask-user",
      "--no-auto-update",
      "--disable-builtin-mcps",
      req.resumeSessionId ? `--resume=${req.resumeSessionId}` : "--session-id",
    ];
    if (!req.resumeSessionId) argv.push(req.sessionId);
    if (req.model) argv.push("--model", req.model);
    if (req.effort) argv.push("--reasoning-effort", req.effort);
    if (req.permissionMode === "acceptEdits") argv.push("--allow-tool", "write");
    for (const rule of req.allowedTools ?? []) argv.push("--allow-tool", rule);
    for (const rule of req.disallowedTools ?? []) argv.push("--deny-tool", rule);
    if (req.appendSystemPrompt) argv.push("--add-dir", workDir, "--agent", COPILOT_PERSONA_AGENT);
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
      if (req.appendSystemPrompt) writePersona(workDir, req.appendSystemPrompt);
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
      child = spawn(this.binary, argv, {
        cwd: req.cwd,
        env: copilotEnv(req.envPassthrough),
        stdio: ["pipe", "pipe", "pipe"], // stdin carries the prompt, never argv
        shell: false,
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
          // No MCP for this harness yet (`mcpInherit: false`): a user-level server that loaded
          // anyway would hand the agent tools nobody allow-listed. End the run, never ignore it.
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
        stderrTail = (stderrTail + chunk).slice(-4000);
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
        const sessionNotFound = !!req.resumeSessionId && isCopilotSessionNotFound(state.lines, stderrTail);
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
  for (const dir of effectivePath(env["PATH"]).split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "copilot.cmd" : "copilot");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function copilotNotFound(configured: string | null): string {
  if (process.env["COPILOT_BIN"]) return `GitHub Copilot CLI not found at COPILOT_BIN (${process.env["COPILOT_BIN"]})`;
  return configured
    ? `GitHub Copilot CLI not found at copilot.binary (${configured})`
    : "GitHub Copilot CLI not found on PATH; set copilot.binary in duskfleet.yaml";
}
