/**
 * The human views of `doctor`, `install-service`, `uninstall-service` and `mcp status`
 * (packages/mcp/src/render), as exact plain lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import {
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

const CLAUDE_LINES = [
  "Claude",
  "  binary   /usr/local/bin/claude",
  "  version  2.1.0 (Claude Code)",
  "  node     v24.1.0",
];
const PATHS_LINES = [
  "Paths",
  "  config  /srv/repo/config (repo)",
  "  data    /srv/repo/data (config)",
  "  config lookup, first match wins:",
  "    env   -",
  "    repo  /srv/repo/config  (used)",
  "    user  /home/me/.config/duskfleet",
];

test("doctor: a healthy report in sections, no Budgets or Probe section", () => {
  assert.deepEqual(renderDoctor(HEALTHY, plain), [
    ...CLAUDE_LINES,
    "",
    ...PATHS_LINES,
    "",
    "Agents",
    "  count  2",
    "  ids    fixer, reviewer",
    "",
    "Scheduler",
    "  enabled      yes",
    "  ticking      yes (serve@box pid 4242)",
    "  service      systemd: active (running)",
    "  service pid  4242",
    "",
    "Orphans",
    "  recovered  0",
  ]);
});

test("doctor: advice, duplicates, unpriced runs and orphans are warnings", () => {
  const report = {
    ...HEALTHY,
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
    ...CLAUDE_LINES,
    "",
    ...PATHS_LINES,
    "  PATH was missing or minimal: the usual install directories were put in front for claude",
    "",
    "Agents",
    "  count       2",
    "  ids         fixer, reviewer",
    "  duplicates  fixer (more than one schedule)",
    "",
    "Scheduler",
    "  enabled  yes",
    "  ticking  no",
    "  service  not installed",
    "  ! schedules fire only while an MCP host keeps the server alive",
    '  ! agent "fixer" has 2 schedules; one schedule per agent',
    "",
    "Budgets",
    "  global  1 unpriced run(s), counted $4.50 / $5.00 warn",
    "  ! 1 run(s) without a recorded cost count against the global budget",
    "",
    "Orphans",
    "  recovered  1",
    "    run-1  fixer, was running",
    "  ! marked 1 run(s) failed with the orphaned error: their owning process is gone",
  ]);
});

test("doctor: a missing binary shows its error and an unknown version", () => {
  const lines = renderDoctor({ ...HEALTHY, claudeVersion: null, error: "Error: spawn claude ENOENT" }, plain);
  assert.deepEqual(lines.slice(0, 5), [
    "Claude",
    "  binary   /usr/local/bin/claude",
    "  version  unknown",
    "  error    Error: spawn claude ENOENT",
    "  node     v24.1.0",
  ]);
});

const NOTE = "doctor --probe makes one real Claude run on haiku";

test("doctor --probe: a Probe section, ok or failed with its advice", () => {
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
  assert.deepEqual(ok.slice(ok.indexOf("Probe")), [
    "Probe",
    "  outcome   completed, ok",
    "  model     haiku",
    "  duration  2.3s",
    "  cost      $0.0123",
    "  result    pong",
    `  ${NOTE}`,
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
  assert.deepEqual(failed.slice(failed.indexOf("Probe")), [
    "Probe",
    "  outcome   failed",
    "  model     haiku",
    "  duration  900ms",
    "  error     Please run /login",
    "  ! Claude Code is not authenticated",
    `  ${NOTE}`,
  ]);
});

test("doctor: colour only when asked for", () => {
  const colored = renderDoctor(HEALTHY, { ...plain, color: true }).join("\n");
  assert.ok(colored.includes("\u001b["), "escape codes with color: true");
  assert.ok(!renderDoctor(HEALTHY, plain).join("\n").includes("\u001b["), "none with color: false");
});

test("install-service: status, paths, the commands run and the notes", () => {
  const lines = renderServiceInstalled(
    {
      installed: true,
      platform: "darwin",
      label: "com.duskfleet.scheduler",
      unitPath: "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
      logPath: "/srv/data/logs/serve.log",
      keepAwake: true,
      ran: ["launchctl bootstrap gui/501 /home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist"],
      status: {
        platform: "darwin",
        supported: true,
        label: "com.duskfleet.scheduler",
        unitPath: "/home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
        installed: true,
        running: true,
        pid: 77,
        detail: "launchd: running pid 77",
      },
      notes: ["Re-run install-service after every build."],
    },
    plain,
  );
  assert.deepEqual(lines, [
    "service com.duskfleet.scheduler installed (launchd)",
    "",
    "status      launchd: running pid 77",
    "unit        /home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
    "log         /srv/data/logs/serve.log",
    "keep awake  yes (caffeinate -i -s)",
    "",
    "ran:",
    "  launchctl bootstrap gui/501 /home/me/Library/LaunchAgents/com.duskfleet.scheduler.plist",
    "",
    "notes:",
    "  - Re-run install-service after every build.",
  ]);
});

test("uninstall-service: one line", () => {
  assert.deepEqual(renderServiceUninstalled({ uninstalled: true, removed: true, ran: [] }, plain), [
    "service uninstalled: unit file removed",
  ]);
  assert.deepEqual(renderServiceUninstalled({ uninstalled: true, removed: false, ran: [] }, plain), [
    "service uninstalled: no unit file was present",
  ]);
});

test("mcp status: one block per host, env names only", () => {
  const lines = renderMcpStatus(
    [
      {
        target: "claude-code",
        configPath: "/home/me/.claude.json",
        registered: true,
        command: "node",
        args: ["/srv/duskfleet/dist/index.js"],
        env: { CLAUDE_BIN: "/usr/local/bin/claude-secret-path" },
        error: null,
      },
      {
        target: "claude-desktop",
        configPath: "/home/me/.config/Claude/claude_desktop_config.json",
        registered: false,
        command: null,
        args: [],
        env: {},
        error: "Unexpected token } in JSON",
      },
    ],
    plain,
  );
  assert.deepEqual(lines, [
    "Claude Code",
    "  registered  yes",
    "  config      /home/me/.claude.json",
    "  command     node /srv/duskfleet/dist/index.js",
    "  env         CLAUDE_BIN",
    "",
    "Claude Desktop",
    "  registered  no",
    "  config      /home/me/.config/Claude/claude_desktop_config.json",
    "  error       Unexpected token } in JSON",
  ]);
  assert.doesNotMatch(lines.join("\n"), /claude-secret-path/, "env values are never printed");
});
