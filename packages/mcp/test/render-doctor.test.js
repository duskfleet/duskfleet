/**
 * The human views of `doctor`, `install-service`, `uninstall-service` and `mcp status`
 * (packages/mcp/src/render, DS-33), as exact plain lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import {
  AGENT_CREATE,
  renderDoctor,
  renderMcpStatus,
  renderServiceInstalled,
  renderServiceUninstalled,
} from "../dist/render/index.js";

const plain = { color: false, width: 100, now: new Date("2026-11-10T12:00:00Z") };

const HEALTHY = {
  node: "v24.1.0",
  claudeBinary: "/usr/local/bin/claude",
  claudeVersion: "2.1.0 (Claude Code)",
  path: "/usr/local/bin:/usr/bin:/bin",
  pathDefaulted: false,
  error: null,
  configDir: "/srv/repo/config",
  configSource: "repo",
  configLookup: { env: null, repo: "/srv/repo/config", user: "/home/me/.config/duskfleet" },
  dataDir: "/srv/repo/data",
  dataSource: "config",
  agents: ["fixer", "reviewer"],
  scheduler: {
    enabled: true,
    ticking: true,
    holder: { role: "serve", host: "box", pid: 4242, expiresAt: "2026-11-10T12:01:00Z" },
    service: {
      platform: "linux",
      supported: true,
      label: "duskfleet.service",
      unitPath: "/home/me/.config/systemd/user/duskfleet.service",
      installed: true,
      running: true,
      pid: 4242,
      detail: "systemd: active (running)",
    },
    keepAwake: null,
    advice: null,
    duplicateSchedules: [],
  },
  unpricedRuns: [],
  orphans: { recovered: [], advice: null },
};

const PAD = " ".repeat(18);

test("doctor: a healthy report is one ✓ line per check, in order, then the json line", () => {
  assert.deepEqual(renderDoctor(HEALTHY, plain), [
    "doctor · 0 warnings · 0 errors",
    "",
    "✓ node            v24.1.0",
    "✓ claude          2.1.0 (Claude Code) · /usr/local/bin/claude",
    "✓ PATH            inherited",
    "✓ config          /srv/repo/config (repo)",
    "✓ data            /srv/repo/data (config)",
    "✓ agents          2: fixer, reviewer",
    "✓ scheduler       enabled · ticking serve@box pid 4242 · service systemd: active (running)",
    "✓ schedules       one per agent",
    "✓ unpriced runs   none",
    "✓ orphans         none recovered",
    "",
    "json: add --json · one real run on haiku: duskfleet doctor --probe",
  ]);
});

test("doctor: advice, duplicates, unpriced runs and orphans are warnings with their advice indented", () => {
  const report = {
    ...HEALTHY,
    agents: [],
    pathDefaulted: true,
    scheduler: {
      enabled: true,
      ticking: false,
      holder: null,
      service: {
        platform: "darwin",
        supported: true,
        label: "com.duskfleet.scheduler",
        unitPath: "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
        installed: false,
        running: false,
        pid: null,
        detail: "not installed",
      },
      keepAwake: { wrapsCaffeinate: null, sleepMinutes: 10, diskSleepMinutes: 10, advice: null },
      advice: "schedules fire only while an MCP host keeps the server alive",
      duplicateSchedules: [
        {
          agentId: "fixer",
          schedules: [
            { id: "s1", name: "a" },
            { id: "s2", name: "b" },
          ],
          warning: 'agent "fixer" has 2 schedules; one schedule per agent',
        },
      ],
    },
    unpricedRuns: [
      {
        budget: "global",
        budgetId: "b1",
        unpricedPolicy: "count",
        state: "warn",
        spentUsd: 1,
        countedUsd: 4.5,
        amountUsd: 5,
        runs: [{ id: "r1", agentId: "fixer", standInUsd: 3.5 }],
        advice: "1 run(s) without a recorded cost count against the global budget",
      },
    ],
    orphans: {
      recovered: [
        { id: "run-1", agentId: "fixer", was: "running", owner: "cli@box:1", createdAt: "2026-11-10T11:00:00Z" },
      ],
      advice: "marked 1 run(s) failed with the orphaned error: their owning process is gone",
    },
  };
  assert.deepEqual(renderDoctor(report, plain), [
    "doctor · 6 warnings · 0 errors",
    "",
    "✓ node            v24.1.0",
    "✓ claude          2.1.0 (Claude Code) · /usr/local/bin/claude",
    "! PATH            defaulted",
    `${PAD}PATH was missing or minimal: the usual install directories were put in front for claude`,
    "✓ config          /srv/repo/config (repo)",
    "✓ data            /srv/repo/data (config)",
    "! agents          none yet",
    `${PAD}${AGENT_CREATE}`,
    "! scheduler       enabled · nothing ticking · service not installed",
    `${PAD}schedules fire only while an MCP host keeps the server alive`,
    "! schedules       1 agent(s) with more than one schedule",
    `${PAD}agent "fixer" has 2 schedules; one schedule per agent`,
    "! unpriced runs   1 this month",
    `${PAD}global: counted $4.50 / $5.00 (warn) · 1 run(s) without a recorded cost count against the global budget`,
    "! orphans         1 recovered",
    `${PAD}run-1  fixer, was running`,
    `${PAD}marked 1 run(s) failed with the orphaned error: their owning process is gone`,
    "",
    "json: add --json · one real run on haiku: duskfleet doctor --probe",
  ]);
});

test("doctor: a missing binary is the only error, `not found` in bright red", () => {
  const missing = { ...HEALTHY, claudeVersion: null, error: "Error: spawn claude ENOENT" };
  const lines = renderDoctor(missing, plain);
  assert.equal(lines[0], "doctor · 0 warnings · 1 error");
  assert.deepEqual(lines.slice(3, 5), [
    "✗ claude          not found",
    `${PAD}/usr/local/bin/claude: Error: spawn claude ENOENT`,
  ]);
  const colored = renderDoctor(missing, { ...plain, color: true });
  assert.ok(colored[3].includes("\u001b[91m\u001b[1mnot found"), "not found in bright red bold");
  const failing = renderDoctor({ ...HEALTHY, claudeVersion: null, error: "exit code 3" }, plain);
  assert.equal(failing[0], "doctor · 1 warning · 0 errors", "a binary that fails otherwise is a warning");
});

const NOTE = "doctor --probe makes one real Claude run on haiku";

test("doctor --probe: the probe check last, ok or a warning with its advice", () => {
  const ok = renderDoctor(
    {
      ...HEALTHY,
      probe: {
        ok: true,
        outcome: "completed",
        model: "haiku",
        durationMs: 2300,
        costUsd: 0.0123,
        resultText: "pong",
        error: null,
        lingeredAfterResult: false,
        advice: null,
        note: NOTE,
      },
    },
    plain,
  );
  assert.deepEqual(ok.slice(-4), [
    "✓ probe           completed, ok · haiku · 2.3s · $0.01",
    `${PAD}${NOTE}`,
    "",
    "json: add --json",
  ]);

  const failed = renderDoctor(
    {
      ...HEALTHY,
      probe: {
        ok: false,
        outcome: "failed",
        model: "haiku",
        durationMs: 900,
        costUsd: null,
        resultText: null,
        error: "Please run /login",
        lingeredAfterResult: false,
        advice: "Claude Code is not authenticated",
        note: NOTE,
      },
    },
    plain,
  );
  assert.equal(failed[0], "doctor · 1 warning · 0 errors");
  assert.deepEqual(failed.slice(-6), [
    "! probe           failed · haiku · 900ms",
    `${PAD}Please run /login`,
    `${PAD}Claude Code is not authenticated`,
    `${PAD}${NOTE}`,
    "",
    "json: add --json",
  ]);
});

test("doctor: colour only when asked for", () => {
  const colored = renderDoctor(HEALTHY, { ...plain, color: true }).join("\n");
  assert.ok(colored.includes("\u001b[32m✓\u001b[39m"), "green glyphs with color: true");
  assert.ok(!renderDoctor(HEALTHY, plain).join("\n").includes("\u001b["), "none with color: false");
});

const RUNNING = {
  platform: "darwin",
  supported: true,
  label: "com.duskfleet.scheduler",
  unitPath: "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
  installed: true,
  running: true,
  pid: 77,
  detail: "launchd: running pid 77",
};

test("install-service: a ✓ line with the manager's state, the file written, the command that checks it", () => {
  const value = {
    installed: true,
    platform: "darwin",
    label: "com.duskfleet.scheduler",
    unitPath: "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
    logPath: "/srv/data/logs/serve.log",
    keepAwake: true,
    ran: ["launchctl bootstrap gui/501 /home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist"],
    status: RUNNING,
    notes: ["Re-run install-service after every build."],
  };
  assert.deepEqual(renderServiceInstalled(value, plain), [
    "✓ service com.duskfleet.scheduler installed (launchd, keep awake) · launchd: running pid 77",
    "  wrote /home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist · log /srv/data/logs/serve.log",
    "  check it: duskfleet doctor",
  ]);
  const down = renderServiceInstalled(
    { ...value, status: { ...RUNNING, running: false, detail: "launchd: not running" } },
    plain,
  );
  assert.equal(down[0], "✗ service com.duskfleet.scheduler installed (launchd, keep awake) · launchd: not running");
});

test("uninstall-service: a ✓ line and what was removed", () => {
  assert.deepEqual(renderServiceUninstalled({ uninstalled: true, removed: true, ran: [] }, plain), [
    "✓ service uninstalled",
    "  removed the unit file",
  ]);
  assert.deepEqual(renderServiceUninstalled({ uninstalled: true, removed: false, ran: [] }, plain), [
    "✓ service uninstalled",
    "  no unit file was present",
  ]);
});

const STATUS_CODE = {
  target: "claude-code",
  configPath: "/home/me/.claude.json",
  registered: true,
  command: "node",
  args: ["/srv/duskfleet/dist/index.js"],
  env: { CLAUDE_BIN: "/usr/local/bin/claude-secret-path" },
  error: null,
};

test("mcp status: HOST · CONFIG · ENTRY · RUNS, env names only, the register command for the first missing host", () => {
  const lines = renderMcpStatus(
    [
      STATUS_CODE,
      {
        target: "claude-desktop",
        configPath: "/home/me/Library/Application Support/Claude/claude_desktop_config.json",
        registered: false,
        command: null,
        args: [],
        env: {},
        error: "Unexpected token } in JSON",
      },
    ],
    plain,
  );
  assert.equal(lines[0], "HOST                    CONFIG                              ENTRY   RUNS");
  assert.equal(
    lines[1],
    "Claude Code             /home/me/.claude.json               ✓ yes   node /srv/duskfleet/dist/index.…",
    "RUNS fills the rest of the line and is cut there",
  );
  assert.match(renderMcpStatus([{ ...STATUS_CODE }], { ...plain, width: 160 })[1], /index\.js · env CLAUDE_BIN$/);
  assert.match(lines[2], /^Claude Desktop {10}\/home\/me\/Libr.*\/…\/.*config\.json {2}✗ no {4}-$/);
  assert.equal(lines[3], "  └ Unexpected token } in JSON");
  assert.deepEqual(lines.slice(4), [
    "",
    "register: duskfleet mcp register --target claude-desktop",
    "json: add --json · env values only with --json",
  ]);
  assert.doesNotMatch(lines.join("\n"), /claude-secret-path/, "env values are never printed");
});
