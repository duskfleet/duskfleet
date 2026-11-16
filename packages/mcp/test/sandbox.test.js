/**
 * Opt-in sandbox per agent (issue #447): `sandbox: true` turns on Claude Code's native sandbox
 * with `--settings`, a host without it refuses the run, and a network block the sandbox reports
 * (`tool_result_meta[].remedy.kind == "sandbox_violation"`) makes the run needs review. The shapes
 * replayed by fake-claude.js ("sandbox" prompt) come from real runs on 2.1.325.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  agentToSpec,
  ClaudeCodeExecutor,
  createAgentFromFields,
  createStreamState,
  ingestLine,
  loadConfig,
  mergeResults,
  openDatabase,
  REVIEW_REASON_LABELS,
  RunManager,
  RunRepository,
  reviewReasons,
  sandboxSettings,
  sandboxSupport,
} from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderDoctor, sandboxReport } from "../dist/render/index.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

const AVAILABLE = () => ({ available: true, platform: "darwin", detail: "Seatbelt (sandbox-exec)", missing: [] });
const MISSING = () => ({
  available: false,
  platform: "linux",
  detail: "bwrap not found on PATH (install bubblewrap and socat)",
  missing: ["bwrap"],
});

function makeApp({ support = AVAILABLE } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "duskfleet-sandbox-")));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: plain\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.5\n  setting_sources: [project, local]\n  env_passthrough: ["FAKE_CLAUDE_*"]\n`,
  );
  writeFileSync(path.join(configDir, "agents", "plain.md"), `---\npermission_mode: dontAsk\n---\nBe brief.\n`);
  writeFileSync(
    path.join(configDir, "agents", "boxed.md"),
    `---\npermission_mode: dontAsk\nsandbox: true\nsandbox_allowed_domains: [registry.npmjs.org, api.github.com]\n---\nBe brief.\n`,
  );
  writeFileSync(
    path.join(configDir, "agents", "ghbox.md"),
    `---\npermission_mode: dontAsk\nsandbox: true\nsandbox_allowed_domains: [github.com, api.github.com]\nsandbox_weaker_network_isolation: true\n---\nUse gh.\n`,
  );
  writeFileSync(
    path.join(configDir, "agents", "offline.md"),
    `---\npermission_mode: dontAsk\nsandbox: true\n---\nNo network.\n`,
  );
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const executor = new ClaudeCodeExecutor({
    binary: config.claude.binary,
    strictMcpConfig: true,
    settingSources: config.claude.settingSources,
    allowBypassPermissions: false,
  });
  const repo = new RunRepository(db);
  const runs = new RunManager(config, repo, executor, { sandboxSupport: support });
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, configDir, config, project, runs, db, cleanup };
}

test("sandboxSettings: sandbox on, no unsandboxed fallback, the hosts under network.allowedDomains", () => {
  assert.deepEqual(JSON.parse(sandboxSettings(["registry.npmjs.org", "api.github.com", "api.github.com"])), {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ["registry.npmjs.org", "api.github.com"] },
    },
  });
  // No list: the verified "every host denied" shape, without a network key.
  assert.deepEqual(JSON.parse(sandboxSettings([])), { sandbox: { enabled: true, allowUnsandboxedCommands: false } });
});

test("sandboxSettings: weaker network isolation only when asked, otherwise the exact earlier string", () => {
  const before =
    '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"network":{"allowedDomains":["github.com"]}}}';
  assert.equal(sandboxSettings(["github.com"]), before);
  assert.equal(sandboxSettings(["github.com"], {}), before);
  assert.equal(sandboxSettings(["github.com"], { weakerNetworkIsolation: false }), before);
  // The value verified with real runs in issue #449, byte for byte.
  assert.equal(
    sandboxSettings(["github.com", "api.github.com"], { weakerNetworkIsolation: true }),
    '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"enableWeakerNetworkIsolation":true,"network":{"allowedDomains":["github.com","api.github.com"]}}}',
  );
});

test("sandboxSupport: Seatbelt on macOS, bwrap and socat on Linux, nothing on Windows", () => {
  const has = (files) => (f) => files.includes(f);
  assert.equal(sandboxSupport("darwin", "/usr/bin", has(["/usr/bin/sandbox-exec"])).available, true);
  assert.equal(sandboxSupport("darwin", "/usr/bin", has([])).available, false);

  const linux = sandboxSupport("linux", "/usr/local/bin:/usr/bin", has(["/usr/bin/bwrap", "/usr/local/bin/socat"]));
  assert.equal(linux.available, true);
  const noSocat = sandboxSupport("linux", "/usr/bin", has(["/usr/bin/bwrap"]));
  assert.equal(noSocat.available, false);
  assert.deepEqual(noSocat.missing, ["socat"]);
  assert.match(noSocat.detail, /socat not found on PATH/);

  const windows = sandboxSupport("win32", "C:\\Windows", has([]));
  assert.equal(windows.available, false);
  assert.match(windows.detail, /no native sandbox on win32/);
});

test("the loader reads sandbox and sandbox_allowed_domains, and refuses a domain that is not a host name", () => {
  const app = makeApp();
  try {
    const boxed = app.config.agents.get("boxed");
    assert.equal(boxed.sandbox, true);
    assert.deepEqual(boxed.sandboxAllowedDomains, ["registry.npmjs.org", "api.github.com"]);
    assert.deepEqual(agentToSpec(boxed).sandbox_allowed_domains, ["registry.npmjs.org", "api.github.com"]);
    assert.equal(app.config.agents.get("plain").sandbox, undefined);

    writeFileSync(
      path.join(app.configDir, "agents", "bad.md"),
      `---\nsandbox: true\nsandbox_allowed_domains: ["https://github.com"]\n---\nBad.\n`,
    );
    assert.throws(() => loadConfig(app.configDir), /exact host names/);
    writeFileSync(
      path.join(app.configDir, "agents", "bad.md"),
      `---\nsandbox: true\nsandbox_allowed_domains: ["*.github.com"]\n---\nBad.\n`,
    );
    assert.throws(() => loadConfig(app.configDir), /exact host names/);
  } finally {
    rmSync(app.root, { recursive: true, force: true });
    app.db.close();
  }
});

test("create refuses sandbox_allowed_domains without sandbox: true; a sandboxed agent round-trips", () => {
  const app = makeApp();
  try {
    const reload = () => loadConfig(app.configDir);
    const file = path.join(app.config.userAgentsDir, "web.md");
    assert.throws(
      () =>
        createAgentFromFields(
          "own",
          { id: "web", system_prompt: "Hi.", sandbox_allowed_domains: ["github.com"] },
          app.config,
          reload,
        ),
      /sandbox_allowed_domains needs sandbox: true/,
    );
    assert.equal(existsSync(file), false, "nothing written");

    const agent = createAgentFromFields(
      "own",
      { id: "web", system_prompt: "Hi.", sandbox: true, sandbox_allowed_domains: ["github.com"] },
      app.config,
      reload,
    );
    assert.equal(agent.sandbox, true);
    assert.deepEqual(agent.sandboxAllowedDomains, ["github.com"]);
    assert.match(readFileSync(file, "utf8"), /sandbox: true\nsandbox_allowed_domains:\n {2}- github.com/);
  } finally {
    rmSync(app.root, { recursive: true, force: true });
    app.db.close();
  }
});

test("sandbox_weaker_network_isolation: loaded, refused without sandbox: true, round-trips through create", () => {
  const app = makeApp();
  try {
    const ghbox = app.config.agents.get("ghbox");
    assert.equal(ghbox.sandboxWeakerNetworkIsolation, true);
    assert.equal(agentToSpec(ghbox).sandbox_weaker_network_isolation, true);
    assert.equal(app.config.agents.get("boxed").sandboxWeakerNetworkIsolation, undefined);
    assert.equal("sandbox_weaker_network_isolation" in agentToSpec(app.config.agents.get("boxed")), false);

    const reload = () => loadConfig(app.configDir);
    const file = path.join(app.config.userAgentsDir, "gh.md");
    for (const fields of [
      { id: "gh", system_prompt: "Hi.", sandbox_weaker_network_isolation: true },
      { id: "gh", system_prompt: "Hi.", sandbox: false, sandbox_weaker_network_isolation: true },
    ]) {
      assert.throws(
        () => createAgentFromFields("own", fields, app.config, reload),
        /sandbox_weaker_network_isolation needs sandbox: true/,
      );
      assert.equal(existsSync(file), false, "nothing written");
    }
    // false without the sandbox loosens nothing: accepted.
    assert.doesNotThrow(() =>
      createAgentFromFields(
        "own",
        { id: "gh-off", system_prompt: "Hi.", sandbox_weaker_network_isolation: false },
        app.config,
        reload,
      ),
    );

    const agent = createAgentFromFields(
      "own",
      {
        id: "gh",
        system_prompt: "Hi.",
        sandbox: true,
        sandbox_allowed_domains: ["github.com"],
        sandbox_weaker_network_isolation: true,
      },
      app.config,
      reload,
    );
    assert.equal(agent.sandboxWeakerNetworkIsolation, true);
    assert.match(readFileSync(file, "utf8"), /sandbox_weaker_network_isolation: true\n/);
    assert.equal(reload().agents.get("gh").sandboxWeakerNetworkIsolation, true);
  } finally {
    rmSync(app.root, { recursive: true, force: true });
    app.db.close();
  }
});

test("update_agent over MCP: sets, refuses and clears sandbox_weaker_network_isolation; list_agents shows it", async () => {
  const app = makeApp();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: app.configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "sandbox-test", version: "0.0.0" });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError ?? false, text: r.content[0].text };
  };
  try {
    await client.connect(transport);
    // No domain list: dropping the sandbox below must trip this key's own check, not the domains'.
    const created = await call("create_agent", { id: "gh", kind: "own", system_prompt: "Hi.", sandbox: true });
    assert.equal(created.error, false, created.text);
    assert.equal(JSON.parse(created.text).agent.sandboxWeakerNetworkIsolation, false);

    const set = await call("update_agent", { id: "gh", sandbox_weaker_network_isolation: true });
    assert.equal(set.error, false, set.text);
    assert.equal(JSON.parse(set.text).agent.sandboxWeakerNetworkIsolation, true);

    const listed = JSON.parse((await call("list_agents", {})).text).agents.find((a) => a.id === "gh");
    assert.equal(listed.sandboxWeakerNetworkIsolation, true);

    // Dropping the sandbox while the key stays is refused, and the file is left as it was.
    const file = path.join(app.config.userAgentsDir, "gh.md");
    const before = readFileSync(file, "utf8");
    const refused = await call("update_agent", { id: "gh", sandbox: false });
    assert.equal(refused.error, true);
    assert.match(refused.text, /sandbox_weaker_network_isolation needs sandbox: true/);
    assert.equal(readFileSync(file, "utf8"), before);

    const cleared = await call("update_agent", { id: "gh", clear: ["sandbox_weaker_network_isolation"] });
    assert.equal(cleared.error, false, cleared.text);
    assert.equal(JSON.parse(cleared.text).agent.sandboxWeakerNetworkIsolation, false);
    assert.doesNotMatch(readFileSync(file, "utf8"), /sandbox_weaker_network_isolation/);
  } finally {
    await client.close();
    rmSync(app.root, { recursive: true, force: true });
    app.db.close();
  }
});

test("an agent without the switch gets no --settings: today's argv", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "sandbox", projectPath: app.project, agentId: "plain" });
    assert.ok(!started.command.argv.includes("--settings"));
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.resultText, "settings none");
  } finally {
    await app.cleanup();
  }
});

test("a sandboxed agent runs with --settings; a network block is needs review, a file block is not detected", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "sandbox", projectPath: app.project, agentId: "boxed" });
    const argv = started.command.argv;
    const settings = argv[argv.indexOf("--settings") + 1];
    assert.deepEqual(JSON.parse(settings), {
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ["registry.npmjs.org", "api.github.com"] },
      },
    });
    assert.ok(argv.includes("--setting-sources"), "--settings goes next to --setting-sources project,local");

    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.resultText, `settings ${settings}`, "the child received the same --settings value");
    assert.equal(run.permissionDenials, 0, "Claude Code reports no denial for a sandbox block");
    // One structured marker (network); the EPERM write has none and is not counted.
    assert.equal(run.sandboxViolations, 1);
    assert.deepEqual(run.reviewReasons, ["sandbox_blocked"]);

    const notes = app.runs
      .events(run.id)
      .filter((e) => e.type === "note")
      .map((e) => e.payload.message);
    assert.deepEqual(notes, ["sandbox blocked a command: deny network-outbound example.org:443 (user denied)"]);
  } finally {
    await app.cleanup();
  }
});

test("a sandboxed agent with sandbox_weaker_network_isolation gets enableWeakerNetworkIsolation in --settings", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "sandbox", projectPath: app.project, agentId: "ghbox" });
    const argv = started.command.argv;
    const settings = argv[argv.indexOf("--settings") + 1];
    assert.equal(
      settings,
      '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false,"enableWeakerNetworkIsolation":true,"network":{"allowedDomains":["github.com","api.github.com"]}}}',
    );
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.resultText, `settings ${settings}`, "the child received the same --settings value");
  } finally {
    await app.cleanup();
  }
});

test("a sandboxed agent without a domain list gets the no-network settings", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "offline" });
    const argv = started.command.argv;
    assert.deepEqual(JSON.parse(argv[argv.indexOf("--settings") + 1]), {
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
    });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.sandboxViolations, 0);
    assert.deepEqual(run.reviewReasons, []);
  } finally {
    await app.cleanup();
  }
});

test("a host without the sandbox refuses a sandboxed agent before spawning; other agents still run", async () => {
  const app = makeApp({ support: MISSING });
  try {
    await assert.rejects(
      () => app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "boxed" }),
      /sets sandbox: true, but Claude Code's sandbox is not available on this host \(bwrap not found.*refused, not started unsandboxed/,
    );
    assert.equal(app.runs.listRuns({}).length, 0, "no run row");
    const plain = await app.runs.startRun({ prompt: "ok", projectPath: app.project, agentId: "plain" });
    assert.equal((await app.runs.waitForRun(plain.id, 10_000)).status, "completed");
  } finally {
    await app.cleanup();
  }
});

test("parser: the remedy marker counts and emits an event; a run of a project with its own sandbox counts too", () => {
  const state = createStreamState();
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          content:
            "Exit code 56\n<sandbox_violations>\ndeny network-outbound example.org:443 (user denied)\n</sandbox_violations>",
          is_error: true,
          tool_use_id: "toolu_1",
        },
      ],
    },
    parent_tool_use_id: null,
    tool_result_meta: [{ id: "toolu_1", remedy: { kind: "sandbox_violation" } }],
  });
  const events = ingestLine(state, line);
  assert.deepEqual(events, [
    {
      type: "sandbox_violation",
      toolUseId: "toolu_1",
      violations: ["deny network-outbound example.org:443 (user denied)"],
      agentId: null,
    },
  ]);
  assert.equal(state.sandboxViolations, 1);

  // Prose alone is never a marker.
  const prose = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "<sandbox_violations>x</sandbox_violations>", tool_use_id: "t2" }],
    },
    tool_result_meta: [{ id: "t2", permission_decision: { decision: "accept" } }],
  });
  assert.deepEqual(ingestLine(state, prose), []);
  assert.equal(state.sandboxViolations, 1);
});

test("reviewReasons: sandbox_blocked from the count; mergeResults sums both passes", () => {
  const base = {
    status: "completed",
    terminationReason: "completed",
    error: null,
    exitCode: 0,
    humanIntervention: false,
    permissionDenials: 0,
    contextExhausted: false,
    toolCalls: 2,
  };
  assert.deepEqual(reviewReasons({ ...base, sandboxViolations: 2 }), ["sandbox_blocked"]);
  assert.deepEqual(reviewReasons({ ...base, sandboxViolations: 0 }), []);
  assert.deepEqual(reviewReasons({ ...base, sandboxViolations: null }), [], "older rows: none known");
  assert.deepEqual(reviewReasons({ ...base, status: "cancelled", sandboxViolations: 1 }), []);
  assert.equal(REVIEW_REASON_LABELS.sandbox_blocked, "sandbox blocked a command");

  const pass = {
    outcome: "completed",
    sessionId: "s",
    model: "haiku",
    startedAt: "2026-11-16T10:00:00.000Z",
    endedAt: "2026-11-16T10:01:00.000Z",
    durationMs: 60_000,
    exitCode: 0,
    signal: null,
    terminationReason: "completed",
    error: null,
    resultText: null,
    numTurns: 1,
    toolCalls: 1,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    usageByModel: null,
    costUsd: 0.01,
    permissionDenials: 0,
    deniedTools: [],
    contextExhausted: false,
    failure: null,
    rawResult: null,
    subagents: [],
  };
  assert.equal(mergeResults({ ...pass, sandboxViolations: 1 }, { ...pass, sandboxViolations: 2 }).sandboxViolations, 3);
  assert.equal(mergeResults(pass, pass).sandboxViolations, 0, "executors that cannot tell count as none");
});

test("doctor: sandbox line, a warning only when an agent needs a sandbox this host lacks", () => {
  const opts = { color: false, width: 120 };
  const report = (sandbox) => ({
    node: "v24.0.0",
    claudeBinary: "/bin/claude",
    claudeVersion: "9.9.9",
    path: "/usr/bin",
    pathDefaulted: false,
    error: null,
    configDir: "/c",
    configSource: "repo",
    configLookup: { env: null, repo: "/c", user: "/u" },
    dataDir: "/d",
    dataSource: "config",
    agents: ["boxed"],
    scheduler: {
      enabled: true,
      ticking: true,
      holder: null,
      service: { supported: true, installed: true, running: true, detail: "running", advice: null },
      keepAwake: null,
      advice: null,
      duplicateSchedules: [],
    },
    unpricedRuns: [],
    orphans: { recovered: [], advice: null },
    sandbox,
  });
  const line = (sandbox) => renderDoctor(report(sandbox), opts).find((l) => l.includes("sandbox"));

  assert.match(
    line(sandboxReport({ available: true, detail: "Seatbelt (sandbox-exec)" }, ["boxed"])),
    /available, Seatbelt \(sandbox-exec\) · used by boxed/,
  );
  assert.match(
    line(sandboxReport({ available: false, detail: "no native sandbox on win32" }, [])),
    /not available here, no agent uses it/,
  );

  const missing = sandboxReport({ available: false, detail: "bwrap not found on PATH" }, ["boxed"]);
  assert.equal(missing.advice, "boxed sets sandbox: true: every run of it is refused on this host");
  const lines = renderDoctor(report(missing), opts);
  assert.match(lines[0], /1 warning/);
  assert.ok(lines.some((l) => l.includes("every run of it is refused on this host")));
});
