/**
 * Minimal stderr logger.
 *
 * stdout is reserved for the MCP stdio transport, so every diagnostic line
 * must go to stderr or it will corrupt the protocol stream.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** DUSKFLEET_LOG_LEVEL when it names a level; it always wins over the entry point's default. */
const fromEnv = parseLogLevel(process.env["DUSKFLEET_LOG_LEVEL"]);
let threshold = LEVELS[fromEnv ?? "info"];

/** A level name, or null for anything else (unset, empty, a typo). */
export function parseLogLevel(value: string | undefined): LogLevel | null {
  return value !== undefined && Object.hasOwn(LEVELS, value) ? (value as LogLevel) : null;
}

/**
 * The level used when DUSKFLEET_LOG_LEVEL is not set. `info` unless an entry point says
 * otherwise: the one-shot CLI commands pick `warn` (`--verbose` brings `info` back), `serve` and
 * the MCP server keep `info`, their log is the record.
 */
export function setDefaultLogLevel(level: LogLevel): void {
  if (fromEnv === null) threshold = LEVELS[level];
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const suffix = extra === undefined ? "" : " " + safeJson(extra);
  process.stderr.write(`${ts} [${level}] ${scope}: ${message}${suffix}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write("debug", scope, m, e),
    info: (m: string, e?: unknown) => write("info", scope, m, e),
    warn: (m: string, e?: unknown) => write("warn", scope, m, e),
    error: (m: string, e?: unknown) => write("error", scope, m, e),
  };
}
