/**
 * Cursor Agent CLI executor (`harness: cursor`, issue #467, docs/harnesses.md).
 *
 * Flags verified by hand on Cursor Agent CLI 2026.11.19-f005e9d and 2026.11.22-e9042b2 (fixtures
 * and what each run shows in `packages/mcp/test/fixtures/cursor/README.md`). What the adapter does:
 *
 * - `cursor-agent -p --output-format stream-json --trust`, the prompt on stdin (no prompt argument:
 *   it stays out of argv and `ps`). `--trust` on every run: an untrusted folder exits 1;
 * - `--model <id>`, `--resume <session id>`, `--add-dir <dir>` per extra directory;
 * - permissions are not flags but the `permissions` lists of a `cli-config.json`. The adapter keeps
 *   one configuration directory per agent under the data directory (`<data>/cursor/<agent id>/`,
 *   passed as `CURSOR_CONFIG_DIR`, never in the project: the CLI keeps its sessions there, so it
 *   must be stable for `--resume`) and rewrites `permissions` before every run: the agent's
 *   `allowed_tools` / `disallowed_tools` verbatim, `Write(**)` denied under `dontAsk`, and
 *   `Mcp(*:*)` always denied;
 * - an own agent's body has no channel in the CLI (no system prompt option; `AGENTS.md` under
 *   `--add-dir` and plugin rules were ignored): it is prepended to the task in a marked block, on
 *   every run, resumes included (as Claude's `--append-system-prompt` and Codex's
 *   `developer_instructions` are passed again).
 *
 * Never passed: `--force` / `--yolo` (skip every approval), `--approve-mcps` (writes a lasting
 * approval into the user's home), `--sandbox` (protected nothing observable).
 *
 * Resuming: an unknown session id is not an error for the CLI (it starts a fresh session under that
 * id, exit 0), so the adapter looks for `<config dir>/chats/<any>/<session id>/` first. Without it
 * nothing is spawned and the result says `sessionNotFound`: the run path starts fresh, with a note.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { classifyFailure } from "../observability/failure.js";
import type { RecordedCommand } from "../observability/run.js";
import { logger } from "../util/log.js";
import { childEnv } from "./child-env.js";
import { type CursorStreamState, createCursorState, ingestCursorLine } from "./cursor-stream.js";
import { CURSOR_CAPABILITIES, CURSOR_HARNESS } from "./harness.js";
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

export interface CursorExecutorOptions {
  /** `cursor.binary` from duskfleet.yaml; null = `cursor-agent` on PATH. */
  binary: string | null;
  /** Where the per-agent configuration directories live: `<dataDir>/cursor`. */
  configRoot: string;
  /** `claude.env_passthrough`, for `cursor-agent --version` (a run gets its own list in the request). */
  envPassthrough?: string[];
  /** How long the process group may outlive the `result` line before it is ended. Default 5 s. */
  resultGraceMs?: number;
  /** A run with no stdout line for this long is ended `timed_out`. Default 30 min. */
  inactivityMs?: number;
}

/** Denied in every run: no MCP tool of any server the CLI loads may be called (#467). */
export const CURSOR_MCP_DENY = "Mcp(*:*)";
/** Denied under `dontAsk`: the edit tool cannot write anywhere. */
export const CURSOR_WRITE_DENY = "Write(**)";

const KILL_GRACE_MS = 5_000;
const RESULT_GRACE_MS = 5_000;
/** Backstop only: a run ends on its own `result` line. */
const INACTIVITY_MS = 30 * 60_000;
const OWN_PROCESS_GROUP = process.platform !== "win32";

/**
 * The prompt the CLI gets: the agent's body and the task, each in its own marked block, so the run
 * log shows which is which. No body = the task alone, no block.
 */
export function cursorPrompt(task: string, body: string | undefined): string {
  if (!body?.trim()) return task;
  return [
    "<duskfleet-agent-instructions>",
    body.trim(),
    "</duskfleet-agent-instructions>",
    "",
    "<duskfleet-task>",
    task,
    "</duskfleet-task>",
  ].join("\n");
}

/** The `permissions` lists a run's `cli-config.json` gets. */
export function cursorPermissions(req: Pick<ExecutionRequest, "allowedTools" | "disallowedTools" | "permissionMode">): {
  allow: string[];
  deny: string[];
} {
  const deny = [...(req.disallowedTools ?? [])];
  if (req.permissionMode === "dontAsk") deny.push(CURSOR_WRITE_DENY);
  deny.push(CURSOR_MCP_DENY);
  return { allow: [...new Set(req.allowedTools ?? [])], deny: [...new Set(deny)] };
}

/** An agent id as one directory name (ids are slugs already; anything else is replaced). */
function dirName(agentId: string | undefined): string {
  const id = (agentId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return id && id !== "." && id !== ".." ? id : "_unnamed";
}

/**
 * Writes the run's permissions into `<dir>/cli-config.json`, keeping what the CLI itself wrote
 * there (its defaults, the login's `authInfo`). `approvalMode: "allowlist"` always.
 */
export function writeCursorConfig(dir: string, permissions: { allow: string[]; deny: string[] }): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "cli-config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch {
      // A file the CLI left half-written: start again from the permissions alone.
    }
  }
  const next = `${JSON.stringify({ ...current, version: 1, approvalMode: "allowlist", permissions }, null, 2)}\n`;
  // Unchanged (the usual case, a second run of the same agent): never touch a file a live run reads.
  if (existsSync(file) && readFileSync(file, "utf8") === next) return file;
  // Changed: a temp file renamed over it, so a reader sees the old file or the new one, never half.
  const tmp = path.join(dir, `.cli-config.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, next, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/**
 * Live runs per configuration directory and the permissions each was started with (JSON). One
 * directory per agent holds one `cli-config.json`: a run whose permissions differ from a live run's
 * (the agent file was edited while it ran) is refused rather than changing them under that run.
 */
const liveConfigs = new Map<string, Map<symbol, string>>();

/** Why a run with `permissions` cannot start in `dir` now, or null. */
export function cursorConfigConflict(dir: string, permissions: { allow: string[]; deny: string[] }): string | null {
  const live = liveConfigs.get(dir);
  if (!live?.size) return null;
  const wanted = JSON.stringify(permissions);
  for (const p of live.values()) {
    if (p !== wanted)
      return `another run of this agent is live in ${dir} with different permissions (the agent file changed); start it again when that run has ended`;
  }
  return null;
}

function holdConfig(dir: string, permissions: { allow: string[]; deny: string[] }): () => void {
  const key = Symbol(dir);
  let live = liveConfigs.get(dir);
  if (!live) {
    live = new Map();
    liveConfigs.set(dir, live);
  }
  live.set(key, JSON.stringify(permissions));
  return () => {
    live.delete(key);
    if (!live.size) liveConfigs.delete(dir);
  };
}

/** Whether the CLI has session `id` in configuration directory `dir` (`chats/<hash>/<id>/`). */
export function cursorSessionExists(dir: string, id: string): boolean {
  const chats = path.join(dir, "chats");
  if (!existsSync(chats)) return false;
  try {
    return readdirSync(chats, { withFileTypes: true }).some(
      (d) => d.isDirectory() && existsSync(path.join(chats, d.name, id)),
    );
  } catch {
    return false;
  }
}

export class CursorExecutor implements Executor {
  readonly name = "cursor-agent";
  readonly harness = CURSOR_HARNESS;
  readonly capabilities = CURSOR_CAPABILITIES;
  readonly binary: string;

  /** Throws when no binary is found; `resolveCursorBinary` tells beforehand. */
  constructor(private readonly options: CursorExecutorOptions) {
    const binary = resolveCursorBinary(options.binary);
    if (!binary) throw new Error(cursorNotFound(options.binary));
    this.binary = binary;
  }

  /** The capability check refuses these fields first; a request built elsewhere must not slip through. */
  prepare(request: ExecutionRequest): PrepareResult {
    if (request.inheritMcp) throw new Error("inherit_mcp is not supported by harness cursor");
    if (request.claudeAgent) throw new Error("claude_agent is not supported by harness cursor");
    if (request.sandbox) throw new Error("sandbox is not supported by harness cursor");
    if (request.effort) throw new Error("effort is not supported by harness cursor");
    if (request.network) throw new Error("codex_network is not supported by harness cursor");
    return { notes: [] };
  }

  /** The configuration directory of one agent. */
  configDir(agentId: string | undefined): string {
    return path.join(this.options.configRoot, dirName(agentId));
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
    if (req.permissionMode !== "dontAsk" && req.permissionMode !== "acceptEdits")
      throw new Error(`permission_mode ${req.permissionMode} is not supported by harness cursor`);
    const argv = ["-p", "--output-format", "stream-json", "--trust"];
    if (req.model) argv.push("--model", req.model);
    if (req.resumeSessionId) argv.push("--resume", req.resumeSessionId);
    for (const dir of req.addDirs ?? []) argv.push("--add-dir", dir);
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
    const state = createCursorState();
    const configDir = this.configDir(req.agentId);
    const base = {
      startedAt,
      state,
      sessionId: req.resumeSessionId ?? req.sessionId,
      model: req.model ?? null,
    };

    const refuse = (error: string, sessionNotFound: boolean): ExecutionHandle => {
      const result = finalResult({
        ...base,
        outcome: "failed",
        error,
        endedAt: new Date(),
        exitCode: null,
        signal: null,
        sessionNotFound,
      });
      return { command, pid: null, cancel: () => {}, done: Promise.resolve(result) };
    };

    // The CLI would start an empty session under an unknown id without a word: look first.
    if (req.resumeSessionId && !cursorSessionExists(configDir, req.resumeSessionId))
      return refuse(`cursor session ${req.resumeSessionId} not found in ${configDir}`, true);
    const permissions = cursorPermissions(req);
    const conflict = cursorConfigConflict(configDir, permissions);
    if (conflict) return refuse(conflict, false);
    try {
      writeCursorConfig(configDir, permissions);
    } catch (err) {
      return refuse(`could not write the cursor configuration in ${configDir}: ${String(err)}`, false);
    }
    const release = holdConfig(configDir, permissions);

    let logStream: CappedLogWriter | null = null;
    if (req.logPath) {
      logStream = new CappedLogWriter(req.logPath, req.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, (err) =>
        log.warn("log file write failed", { path: req.logPath, err: err.message }),
      );
    }

    let outcome: ExecutionResult["outcome"] | null = null; // set by cancel / timeout
    let inactive = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let resultTimer: NodeJS.Timeout | null = null;
    let inactivityTimer: NodeJS.Timeout | null = null;
    let graceKilled = false;
    const stderr = { head: "", tail: "", length: 0 };
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
      const plan = spawnPlan(this.binary, argv);
      child = spawn(plan.file, plan.args, {
        cwd: req.cwd,
        env: { ...childEnv(req.envPassthrough), CURSOR_CONFIG_DIR: configDir },
        stdio: ["pipe", "pipe", "pipe"], // stdin carries the prompt, never argv
        shell: false,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: OWN_PROCESS_GROUP,
      });
    } catch (err) {
      release();
      const ended = logStream?.end() ?? Promise.resolve();
      const result = finalResult({
        ...base,
        outcome: "failed",
        error: `spawn failed: ${String(err)}`,
        endedAt: new Date(),
        exitCode: null,
        signal: null,
        sessionNotFound: false,
      });
      return { command, pid: null, cancel: () => {}, done: ended.then(() => result) };
    }
    child.stdin!.on("error", (err) => log.debug("stdin write failed", { pid: child.pid, err: err.message }));
    child.stdin!.end(cursorPrompt(req.prompt, req.appendSystemPrompt), "utf8");

    const resultGraceMs = this.options.resultGraceMs ?? RESULT_GRACE_MS;
    const inactivityMs = this.options.inactivityMs ?? INACTIVITY_MS;
    const graceKill = () => {
      resultTimer = null;
      if (closed || outcome || graceKilled) return;
      graceKilled = true;
      const childAlive = child.exitCode === null && child.signalCode === null;
      log.warn("process still running after its result line; ending its process group", { pid: child.pid });
      emit({ type: "grace_kill", pid: child.pid ?? null, afterMs: resultGraceMs, childAlive });
      endGroup();
    };
    const armInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (closed || state.result) return;
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
        for (const ev of ingestCursorLine(state, line)) emit(ev);
        armInactivity();
        if (state.result && !resultTimer && !graceKilled && !closed) resultTimer = setTimeout(graceKill, resultGraceMs);
      });

      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        if (stderr.head.length < 1000) stderr.head = (stderr.head + chunk).slice(0, 1000);
        stderr.tail = (stderr.tail + chunk).slice(-1000);
        stderr.length += chunk.length;
        logStream?.write(`#stderr ${chunk.replace(/\n(?!$)/g, "\n#stderr ")}`);
        emit({ type: "stderr", text: chunk });
      });
      child.on("error", (err) => {
        spawnError = err.message;
      });

      child.on("close", (code, sig) => {
        closed = true;
        release();
        for (const t of [killTimer, resultTimer, timeoutTimer, inactivityTimer]) if (t) clearTimeout(t);
        const endedAt = new Date();
        let error: string | null = null;
        let finalOutcome: ExecutionResult["outcome"];
        const r = state.result;
        if (outcome) {
          finalOutcome = outcome;
          if (inactive) {
            const span =
              inactivityMs >= 60_000
                ? `${Math.round(inactivityMs / 60_000)} min`
                : `${Math.ceil(inactivityMs / 1000)} s`;
            error = `no output from cursor-agent for ${span}; the run was ended`;
          }
        } else if (spawnError) {
          finalOutcome = "failed";
          error = spawnError;
        } else if (!r) {
          finalOutcome = "failed";
          error = `no result line received (exit ${code ?? "null"}, signal ${sig ?? "none"})${tail(stderr)}`;
        } else if (r["is_error"] === true || r["subtype"] !== "success") {
          finalOutcome = "failed";
          const text = typeof r["result"] === "string" && r["result"].trim() ? `: ${r["result"].slice(-1000)}` : "";
          error = `cursor-agent reported an error (${String(r["subtype"] ?? "no subtype")})${text}`;
        } else if (!graceKilled && code !== null && code !== 0) {
          finalOutcome = "failed";
          error = `exit code ${code}${tail(stderr)}`;
        } else {
          finalOutcome = "completed";
        }
        resolve(
          finalResult({
            ...base,
            outcome: finalOutcome,
            error,
            endedAt,
            exitCode: code,
            signal: sig,
            sessionNotFound: false,
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
 * The stderr of a failed start, for the error. Its first line says why (`Cannot use this model: ...`,
 * "Workspace Trust Required") and can be followed by a long list: the start and the end are kept.
 */
function tail(stderr: { head: string; tail: string; length: number }): string {
  if (!stderr.length) return "";
  const t =
    stderr.length <= 1000
      ? stderr.head.trim()
      : `${stderr.head.slice(0, 700).trim()} ... ${stderr.tail.slice(-300).trim()}`;
  return t ? `\nstderr: ${t}` : "";
}

function finalResult(input: {
  outcome: ExecutionResult["outcome"];
  error: string | null;
  startedAt: Date;
  endedAt: Date;
  exitCode: number | null;
  signal: string | null;
  state: CursorStreamState;
  sessionId: string;
  model: string | null;
  sessionNotFound: boolean;
}): ExecutionResult {
  const { state } = input;
  // A subagent still open when the run ended never reported back.
  for (const s of state.openSubagents.values()) {
    s.status = "interrupted";
    s.endedAt = input.endedAt.toISOString();
  }
  state.openSubagents.clear();
  return {
    outcome: input.outcome,
    // The CLI picks the session id (`system/init`); the caller's stands only when the stream never started.
    sessionId: state.sessionId ?? input.sessionId,
    // The model asked for, else the display name `init` reported ("Auto").
    model: input.model ?? state.model,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: input.endedAt.getTime() - input.startedAt.getTime(),
    exitCode: input.exitCode,
    signal: input.signal,
    terminationReason:
      input.outcome === "cancelled"
        ? "cancelled"
        : state.result
          ? `result_${String(state.result["subtype"] ?? "unknown")}`
          : input.exitCode !== null
            ? `exit_${input.exitCode}`
            : null,
    error: input.error,
    resultText: state.lastAssistantText,
    numTurns: null,
    toolCalls: state.toolCalls,
    usage: state.usage,
    usageByModel: null,
    // The stream reports tokens only: every run is unpriced.
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
    rawResult: state.result,
    subagents: state.subagents,
  };
}

/**
 * The `cursor-agent` binary, first match wins: the `CURSOR_BIN` environment variable (the tests
 * point it at fake-cursor.js so the real CLI is never launched), then `cursor.binary`, then
 * `cursor-agent` on the effective PATH. A path that does not exist is null.
 */
export function resolveCursorBinary(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env["CURSOR_BIN"];
  if (override) return existsSync(override) ? override : null;
  if (configured) return existsSync(configured) ? configured : null;
  const names = process.platform === "win32" ? ["cursor-agent.exe", "cursor-agent.cmd"] : ["cursor-agent"];
  for (const dir of effectivePath(env["PATH"]).split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function cursorNotFound(configured: string | null): string {
  if (process.env["CURSOR_BIN"]) return `Cursor Agent CLI not found at CURSOR_BIN (${process.env["CURSOR_BIN"]})`;
  return configured
    ? `Cursor Agent CLI not found at cursor.binary (${configured})`
    : "Cursor Agent CLI not found on PATH; set cursor.binary in duskfleet.yaml";
}
