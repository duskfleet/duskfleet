/**
 * Codex network opt-in (issue #488): `codex_network: true` turns the `workspace-write` sandbox's
 * network on (`-c sandbox_workspace_write.network_access=true`), only on harness codex and only
 * with `acceptEdits`. Without it the argv is exactly the one #50 verified. Create / update say what
 * it grants, `doctor` lists the agents that have it, the run records a note. Through fake-codex.js:
 * no test launches the real `codex`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import {
  builtinHarnesses,
  ClaudeCodeExecutor,
  CODEX_NETWORK_GRANT,
  CODEX_NETWORK_NOTE,
  CodexExecutor,
  HarnessRegistry,
  harnessGrantWarnings,
  harnessRefusal,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
} from "@duskfleet/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { renderDoctor } from "../dist/render/index.js";
import { testEnv } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCodex = path.join(here, "fake-codex.js");
const serverEntry = path.join(here, "..", "dist", "index.js");

const base = { cwd: "/w", prompt: "p", sessionId: "11111111-2222-4333-8444-555555555555" };
const OFF = "sandbox_workspace_write.network_access=false";
const ON = "sandbox_workspace_write.network_access=true";

function setup(agents = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-codex-net-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  const record = path.join(root, "record.json");
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    [
      "data_dir: ../data",
      `allowed_project_roots: ["${root}"]`,
      "claude:",
      `  binary: "${fakeClaude}"`,
      "  default_max_budget_usd: 2",
      '  env_passthrough: ["FAKE_CODEX_*"]',
      "codex:",
      `  binary: "${fakeCodex}"`,
      "",
    ].join("\n"),
  );
  for (const [id, frontmatter] of Object.entries(agents)) {
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe brief.\n`);
  }
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const claude = new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const codex = new CodexExecutor({ binary: config.codex.binary });
  const runs = new RunManager(config, new RunRepository(db), new HarnessRegistry([claude, codex]));
  process.env.FAKE_CODEX_RECORD = record;
  const cleanup = () => {
    delete process.env.FAKE_CODEX_RECORD;
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  const recorded = () => JSON.parse(readFileSync(record, "utf8"));
  return { root, configDir, project: realpathSync(project), config, runs, recorded, cleanup };
}

const notes = (runs, runId) =>
  runs
    .events(runId)
    .filter((e) => e.type === "note")
    .map((e) => e.payload.message);

test("argv: network on only with the opt-in, fresh and resumed; without it exactly today's", () => {
  const codex = new CodexExecutor({ binary: fakeCodex });
  const off = codex.buildArgv({ ...base, permissionMode: "acceptEdits" });
  assert.deepEqual(off, [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "workspace-write",
    "-c",
    OFF,
    "-",
  ]);
  const on = codex.buildArgv({ ...base, permissionMode: "acceptEdits", network: true });
  assert.deepEqual(on, [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "workspace-write",
    "-c",
    ON,
    "-",
  ]);

  const thread = "01a1f616-dda1-7da0-adb2-81638c8f87ec";
  const resumed = codex.buildArgv({ ...base, permissionMode: "acceptEdits", network: true, resumeSessionId: thread });
  assert.deepEqual(resumed.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.includes('sandbox_mode="workspace-write"'));
  assert.ok(resumed.includes(ON) && !resumed.includes(OFF), "a resumed turn keeps the agent's network");
  assert.ok(codex.buildArgv({ ...base, permissionMode: "acceptEdits", resumeSessionId: thread }).includes(OFF));

  // Never the network on a read-only sandbox, whoever built the request.
  assert.throws(
    () => codex.buildArgv({ ...base, permissionMode: "dontAsk", network: true }),
    /codex_network needs permission_mode acceptEdits/,
  );
  assert.throws(
    () => codex.prepare({ ...base, permissionMode: "dontAsk", network: true }),
    /codex_network needs permission_mode acceptEdits/,
  );
  assert.deepEqual(codex.prepare({ ...base, permissionMode: "acceptEdits", network: true }).notes, [
    CODEX_NETWORK_NOTE,
  ]);
  assert.deepEqual(codex.prepare({ ...base, permissionMode: "acceptEdits" }).notes, []);
});

test("codex_network is refused, by name, on Claude and Copilot and on a dontAsk Codex agent", () => {
  for (const harness of [undefined, "claude", "copilot"]) {
    assert.equal(
      harnessRefusal({ harness, codex_network: true }, builtinHarnesses),
      `codex_network is not supported by harness ${harness ?? "claude"}`,
    );
  }
  assert.match(
    harnessRefusal({ harness: "codex", permission_mode: "dontAsk", codex_network: true }, builtinHarnesses),
    /^codex_network needs permission_mode acceptEdits on harness codex \(this agent has dontAsk\)/,
  );
  for (const fine of [
    { codex_network: true },
    { permission_mode: "acceptEdits", codex_network: true },
    { permission_mode: "dontAsk", codex_network: false },
  ]) {
    assert.equal(harnessRefusal({ harness: "codex", ...fine }, builtinHarnesses), null);
  }
  // false is the default spelled out: nothing to refuse on any harness.
  assert.equal(harnessRefusal({ codex_network: false }, builtinHarnesses), null);
});

test("warnings: what codex_network grants, and the token-like env_passthrough names Codex drops", () => {
  assert.deepEqual(harnessGrantWarnings({ harness: "codex", codexNetwork: true }), [CODEX_NETWORK_GRANT]);
  assert.match(CODEX_NETWORK_GRANT, /every host/);
  assert.match(CODEX_NETWORK_GRANT, /credentials of the user who runs Duskfleet/);
  assert.deepEqual(harnessGrantWarnings({ harness: "codex" }), []);
  const env = harnessGrantWarnings({
    harness: "codex",
    envPassthrough: ["GH_TOKEN", "PLAIN_VAR", "MY_SECRET", "API_KEY_*"],
  });
  assert.equal(env.length, 1);
  assert.match(env[0], /^env_passthrough GH_TOKEN, MY_SECRET, API_KEY_\*: /);
  assert.match(env[0], /no effect inside a Codex run/);
  assert.deepEqual(harnessGrantWarnings({ envPassthrough: ["GH_TOKEN"] }), [], "Claude passes them as before");
});

test("a run with codex_network: the recorded command has network_access=true and a note says so", async () => {
  const t = setup({
    net: "harness: codex\npermission_mode: acceptEdits\ncodex_network: true",
    quiet: "harness: codex\npermission_mode: acceptEdits",
    readonly: "harness: codex\npermission_mode: dontAsk\ncodex_network: true",
  });
  try {
    assert.equal(t.config.agents.get("net").codexNetwork, true);
    const net = await t.runs.waitForRun(
      (await t.runs.startRun({ agentId: "net", projectPath: t.project, prompt: "fixture:edit" })).id,
      15_000,
    );
    assert.equal(net.status, "completed");
    assert.ok(net.command.argv.includes(ON), "the recorded command shows the flag");
    assert.ok(t.recorded().argv.includes(ON));
    assert.ok(notes(t.runs, net.id).includes(CODEX_NETWORK_NOTE));

    const quiet = await t.runs.waitForRun(
      (await t.runs.startRun({ agentId: "quiet", projectPath: t.project, prompt: "fixture:edit" })).id,
      15_000,
    );
    assert.ok(quiet.command.argv.includes(OFF) && !quiet.command.argv.includes(ON));
    assert.ok(!notes(t.runs, quiet.id).includes(CODEX_NETWORK_NOTE));

    // A hand-edited read-only agent with the opt-in is refused at run start, never run.
    await assert.rejects(
      t.runs.startRun({ agentId: "readonly", projectPath: t.project, prompt: "fixture:edit" }),
      /agent "readonly": codex_network needs permission_mode acceptEdits/,
    );
  } finally {
    t.cleanup();
  }
});

test("create_agent / update_agent over MCP: the grant is a warning, refusals are by name, list_agents shows it", async () => {
  const t = setup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: testEnv({ DUSKFLEET_CONFIG: t.configDir, DUSKFLEET_LOG_LEVEL: "warn" }),
    stderr: "pipe",
  });
  const client = new Client({ name: "codex-network-test", version: "0.0.0" });
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { error: r.isError ?? false, text: r.content[0].text };
  };
  try {
    await client.connect(transport);
    const created = await call("create_agent", {
      id: "pusher",
      kind: "own",
      harness: "codex",
      permission_mode: "acceptEdits",
      codex_network: true,
      env_passthrough: ["GH_TOKEN"],
      system_prompt: "Push.",
    });
    assert.equal(created.error, false, created.text);
    const body = JSON.parse(created.text);
    assert.equal(body.agent.codexNetwork, true);
    assert.ok(body.warnings.includes(CODEX_NETWORK_GRANT), "create says what it grants");
    assert.ok(body.warnings.some((w) => /env_passthrough GH_TOKEN: .*no effect inside a Codex run/.test(w)));

    const listed = JSON.parse((await call("list_agents", {})).text).agents.find((a) => a.id === "pusher");
    assert.equal(listed.codexNetwork, true);

    const file = path.join(t.config.userAgentsDir, "pusher.md");
    const before = readFileSync(file, "utf8");
    assert.match(before, /codex_network: true\n/);
    const readOnly = await call("update_agent", { id: "pusher", permission_mode: "dontAsk" });
    assert.equal(readOnly.error, true);
    assert.match(readOnly.text, /codex_network needs permission_mode acceptEdits/);
    const onClaude = await call("update_agent", { id: "pusher", harness: "claude" });
    assert.equal(onClaude.error, true);
    assert.match(onClaude.text, /codex_network is not supported by harness claude/);
    assert.equal(readFileSync(file, "utf8"), before, "a refused update leaves the file as it was");

    const updated = await call("update_agent", { id: "pusher", description: "pushes" });
    assert.ok(JSON.parse(updated.text).warnings.includes(CODEX_NETWORK_GRANT), "update says it again");

    const cleared = await call("update_agent", { id: "pusher", clear: ["codex_network", "env_passthrough"] });
    assert.equal(cleared.error, false, cleared.text);
    assert.equal(JSON.parse(cleared.text).agent.codexNetwork, false);
    assert.deepEqual(JSON.parse(cleared.text).warnings, []);
    assert.doesNotMatch(readFileSync(file, "utf8"), /codex_network/);

    const claude = await call("create_agent", { id: "c", kind: "own", system_prompt: "x", codex_network: true });
    assert.equal(claude.error, true);
    assert.match(claude.text, /codex_network is not supported by harness claude/);
  } finally {
    await client.close();
    t.cleanup();
  }
});

test("doctor lists the agents with codex_network under the harnesses check", () => {
  const plain = { color: false, width: 200, now: new Date("2026-11-22T12:00:00Z") };
  const report = {
    node: "v24.1.0",
    claudeBinary: "/usr/local/bin/claude",
    claudeVersion: "2.1.0",
    path: "/usr/bin",
    pathDefaulted: false,
    error: null,
    configDir: "/srv/config",
    configSource: "repo",
    configLookup: { env: null, repo: "/srv/config", user: "/home/me/.config/duskfleet" },
    dataDir: "/srv/data",
    dataSource: "config",
    agents: ["pusher"],
    scheduler: {
      enabled: true,
      ticking: false,
      holder: null,
      service: { platform: "linux", supported: true, installed: true, running: true, detail: "active" },
      keepAwake: null,
      advice: null,
      duplicateSchedules: [],
    },
    unpricedRuns: [],
    orphans: { recovered: [], advice: null },
  };
  const harnesses = (networked) => ({
    registered: [
      { name: "claude", binary: "/usr/local/bin/claude", version: "2.1.0", error: null, agents: [] },
      { name: "codex", binary: "/usr/local/bin/codex", version: "codex-cli 0.167.1", error: null, agents: ["pusher"] },
    ],
    unknown: [],
    notInstalled: ["copilot"],
    networked,
  });
  const lines = renderDoctor({ ...report, harnesses: harnesses(["pusher"]) }, plain);
  const at = lines.findIndex((l) => l.includes("harnesses"));
  assert.match(lines[at], /^✓ harnesses/, "a grant to keep in view, not a warning");
  assert.match(lines[at + 1], /codex_network: pusher: every host, with the credentials of the user who runs Duskfleet/);
  const none = renderDoctor({ ...report, harnesses: harnesses([]) }, plain);
  assert.ok(!none.some((l) => l.includes("codex_network")));
});
