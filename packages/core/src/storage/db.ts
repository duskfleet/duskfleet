import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reviewReasons, TERMINAL_STATUSES } from "../observability/run.js";
import { logger } from "../util/log.js";

const log = logger("storage");

/**
 * Ordered, idempotent migrations. Add a new entry to change the schema;
 * never edit an applied one. `backfill` runs after the SQL, in the same transaction,
 * for data an SQL statement cannot compute.
 */
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string; backfill?: (db: DatabaseSync) => void }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id                    TEXT PRIMARY KEY,
        agent_id              TEXT NOT NULL,
        project_path          TEXT NOT NULL,
        project_id            TEXT,
        prompt                TEXT NOT NULL,
        model_requested       TEXT,
        model_used            TEXT,
        status                TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        started_at            TEXT,
        ended_at              TEXT,
        duration_ms           INTEGER,
        claude_session_id     TEXT,
        permission_mode       TEXT NOT NULL,
        command_json          TEXT NOT NULL,
        exit_code             INTEGER,
        termination_reason    TEXT,
        error                 TEXT,
        result_text           TEXT,
        num_turns             INTEGER,
        tool_calls            INTEGER,
        input_tokens          INTEGER,
        output_tokens         INTEGER,
        cache_read_tokens     INTEGER,
        cache_creation_tokens INTEGER,
        cost_usd              REAL,
        permission_denials    INTEGER,
        human_intervention    INTEGER NOT NULL DEFAULT 0,
        context_exhausted     INTEGER NOT NULL DEFAULT 0,
        retries               INTEGER NOT NULL DEFAULT 0,
        log_path              TEXT,
        raw_result_json       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

      CREATE TABLE IF NOT EXISTS run_events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id  TEXT NOT NULL REFERENCES runs(id),
        ts      TEXT NOT NULL,
        type    TEXT NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);

      CREATE TABLE IF NOT EXISTS evals (
        id         TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs(id),
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        status     TEXT NOT NULL,
        score      REAL,
        details    TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evals_run ON evals(run_id);
    `,
  },
  {
    version: 2,
    sql: `ALTER TABLE runs ADD COLUMN denied_tools_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    version: 3,
    sql: `ALTER TABLE runs ADD COLUMN mcp_json TEXT NOT NULL DEFAULT '{"mounted":[],"used":[],"allowListedMissing":[]}';`,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS schedules (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        agent_id      TEXT NOT NULL,
        project_id    TEXT,
        prompt        TEXT NOT NULL,
        model         TEXT,
        cron          TEXT NOT NULL,
        time_zone     TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        next_run_at   TEXT,
        last_fired_at TEXT,
        last_outcome  TEXT,
        last_error    TEXT,
        last_run_id   TEXT,
        fires         INTEGER NOT NULL DEFAULT 0,
        skips         INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules (enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS schedule_firings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        fired_at    TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        run_id      TEXT,
        error       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_firings ON schedule_firings (schedule_id, id);
      CREATE TABLE IF NOT EXISTS scheduler_lease (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        holder     TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      ALTER TABLE runs ADD COLUMN schedule_id TEXT;
    `,
  },
  {
    // Subagent invocations: one row per Agent tool call observed in the stream (see SubagentRecord).
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS run_agents (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id                TEXT NOT NULL REFERENCES runs(id),
        agent_id              TEXT NOT NULL,
        parent_tool_use_id    TEXT,
        parent_agent_id       TEXT,
        subagent_type         TEXT NOT NULL,
        description           TEXT,
        prompt                TEXT,
        result_text           TEXT,
        status                TEXT NOT NULL,
        model                 TEXT,
        started_at            TEXT NOT NULL,
        ended_at              TEXT,
        duration_ms           INTEGER,
        tool_calls            INTEGER NOT NULL DEFAULT 0,
        tools_json            TEXT NOT NULL DEFAULT '[]',
        input_tokens          INTEGER,
        output_tokens         INTEGER,
        cache_read_tokens     INTEGER,
        cache_creation_tokens INTEGER,
        total_tokens          INTEGER,
        definition_hash       TEXT,
        UNIQUE (run_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_run_agents_run ON run_agents(run_id);
      CREATE INDEX IF NOT EXISTS idx_run_agents_type ON run_agents(subagent_type);
      ALTER TABLE run_events ADD COLUMN agent_id TEXT;
    `,
  },
  {
    // "Run now" from a process that does not run agents (the dashboard): the request is a
    // timestamp on the row, consumed by whichever process holds the scheduler lease on its next tick.
    version: 6,
    sql: `ALTER TABLE schedules ADD COLUMN run_requested_at TEXT;`,
  },
  {
    // The process supervising a run (`role@host:pid`, see formatHolder). Orphan recovery only
    // fails `running` rows whose owner is gone; NULL = written before this column (always recovered).
    version: 7,
    sql: `ALTER TABLE runs ADD COLUMN owner TEXT;`,
  },
  {
    // The processes behind a run (see RunPhase): the main pass and, after a budget
    // exhaustion, the wrap-up pass that resumed the session with the reserve budget.
    version: 8,
    sql: `ALTER TABLE runs ADD COLUMN phases_json TEXT NOT NULL DEFAULT '[]';`,
  },
  {
    // Why a run needs review, computed once by RunManager at the terminal transition
    // (reviewReasons()); NULL while pending / running. Backfilled with the rule as it was
    // on this date so lists, badges and aggregates share one stored value.
    version: 9,
    sql: `ALTER TABLE runs ADD COLUMN review_reasons_json TEXT;`,
    backfill: backfillReviewReasons,
  },
  {
    // Resume-once on failure: a schedule (or its agent) may resume the session of a run that
    // ended budget_exhausted / timed_out on the next tick, once. The retry run points at the
    // run it resumed; the original is found through the index. The index is unique: the insert
    // of the retry row is the once-only claim, atomic across processes sharing the database.
    version: 10,
    sql: `
      ALTER TABLE schedules ADD COLUMN on_failure TEXT;
      ALTER TABLE schedules ADD COLUMN resume_budget_usd REAL;
      ALTER TABLE runs ADD COLUMN resumed_from_run_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_resumed_from ON runs(resumed_from_run_id);
    `,
  },
  {
    // Idle cost: per-schedule no-op marker (null = scheduler.noop_pattern) and the indexes the
    // 7-day stats read (runs by schedule and date, firings by schedule and date).
    version: 11,
    sql: `
      ALTER TABLE schedules ADD COLUMN noop_pattern TEXT;
      CREATE INDEX IF NOT EXISTS idx_runs_schedule_created ON runs(schedule_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_schedule_firings_time ON schedule_firings(schedule_id, fired_at);
    `,
  },
  {
    // Schedule gates: a cheap check (shell command or gate agent) before the real run. Gate
    // agent runs are runs of kind 'gate', so their cost is counted apart from the real runs.
    version: 12,
    sql: `
      ALTER TABLE schedules ADD COLUMN gate_json TEXT;
      ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'run';
      ALTER TABLE schedule_firings ADD COLUMN gate_run_id TEXT;
      ALTER TABLE schedule_firings ADD COLUMN gate_cost_usd REAL;
    `,
  },
  {
    // Tokens per model from the result line's modelUsage (subagents can run on another model).
    // NULL for older rows and for runs whose result carried no modelUsage.
    version: 13,
    sql: `ALTER TABLE runs ADD COLUMN usage_by_model_json TEXT;`,
  },
  {
    // Who pays for cost_usd: 'api' (ANTHROPIC_API_KEY in the child's environment) or
    // 'subscription'. Set when the run spawns; NULL for older rows (unknown, not guessed).
    version: 14,
    sql: `ALTER TABLE runs ADD COLUMN billing_type TEXT;`,
  },
  {
    // Why a run failed, as a code (classifyFailure): error_code (auth_required, provider_quota, ...),
    // its family (setup / limit / transient / refusal) and the detail some codes carry (login URL,
    // retry_not_before) as JSON. NULL for older rows and for failures that match no code.
    version: 15,
    sql: `
      ALTER TABLE runs ADD COLUMN error_code TEXT;
      ALTER TABLE runs ADD COLUMN error_family TEXT;
      ALTER TABLE runs ADD COLUMN error_detail_json TEXT;
    `,
  },
  {
    // Monthly budgets per scope (global / agent / project), calendar month in UTC, compared with
    // the recorded cost of the scope's runs. One per scope: scope_id is NULL for global, so the
    // unique index is on COALESCE(scope_id, '').
    version: 16,
    sql: `
      CREATE TABLE IF NOT EXISTS budgets (
        id           TEXT PRIMARY KEY,
        scope        TEXT NOT NULL CHECK (scope IN ('global', 'agent', 'project')),
        scope_id     TEXT,
        amount_usd   REAL NOT NULL CHECK (amount_usd > 0),
        warn_percent INTEGER NOT NULL DEFAULT 80,
        hard_stop    INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_scope ON budgets(scope, COALESCE(scope_id, ''));
    `,
  },
];

/**
 * SHA-256 of every migration's SQL (whitespace-normalised), in order. A test pins the
 * digests of the applied migrations so that an edit to an existing entry, instead of a
 * new one, fails the build: an edited migration never reaches databases that already
 * recorded that version.
 */
export function migrationDigests(): ReadonlyArray<{ version: number; sha256: string }> {
  return MIGRATIONS.map((m) => ({
    version: m.version,
    sha256: createHash("sha256").update(m.sql.replace(/\s+/g, " ").trim()).digest("hex"),
  }));
}

function backfillReviewReasons(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, status, termination_reason, error, exit_code, human_intervention, permission_denials, context_exhausted, mcp_json FROM runs WHERE review_reasons_json IS NULL",
    )
    .all() as Array<{
    id: string;
    status: string;
    termination_reason: string | null;
    error: string | null;
    exit_code: number | null;
    human_intervention: number;
    permission_denials: number | null;
    context_exhausted: number;
    mcp_json: string | null;
  }>;
  const update = db.prepare("UPDATE runs SET review_reasons_json = ? WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    if (!TERMINAL_STATUSES.has(r.status as never)) continue;
    let allowListedMissing: string[] = [];
    try {
      const mcp = r.mcp_json ? (JSON.parse(r.mcp_json) as { allowListedMissing?: unknown }) : null;
      if (Array.isArray(mcp?.allowListedMissing)) allowListedMissing = mcp.allowListedMissing as string[];
    } catch {
      // a malformed mcp_json never blocked the dashboard before; it does not block the migration either
    }
    const reasons = reviewReasons({
      status: r.status as never,
      terminationReason: r.termination_reason,
      error: r.error,
      exitCode: r.exit_code,
      humanIntervention: r.human_intervention === 1,
      permissionDenials: r.permission_denials,
      contextExhausted: r.context_exhausted === 1,
      mcp: { allowListedMissing },
    });
    update.run(JSON.stringify(reasons), r.id);
    n++;
  }
  if (n) log.info(`review reasons computed for ${n} finished run(s)`);
}

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "duskfleet.db");
  adoptLegacyDatabase(dataDir, file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      m.backfill?.(db);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
      log.info(`applied migration ${m.version}`);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  log.debug(`database open`, { file });
  return db;
}

/**
 * One-time rename of the pre-DuskFleet database (`gabfactory.db`, with its WAL and shm
 * files) to the new name, so an existing installation keeps its runs. No-op once the
 * new file exists.
 */
function adoptLegacyDatabase(dataDir: string, file: string): void {
  if (existsSync(file)) return;
  const legacy = path.join(dataDir, "gabfactory.db");
  if (!existsSync(legacy)) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(legacy + suffix)) renameSync(legacy + suffix, file + suffix);
  }
  log.info(`renamed legacy database gabfactory.db to ${path.basename(file)}`);
}
