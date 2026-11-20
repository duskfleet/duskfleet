/**
 * The Codex CLI harness (issue #50). fake-codex.js replays the real runs captured in
 * fixtures/codex/ (codex-cli 0.167.1); the real CLI is never launched. Covers the argv per
 * permission mode, the persona as a TOML string, every field Codex cannot honour refused by name,
 * the environment, the parser on each fixture, and runs through RunManager (completed unpriced,
 * failed, cancelled, ended on inactivity).
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
  CODEX_CAPABILITIES,
  CodexExecutor,
  childEnv,
  createCodexState,
  HarnessRegistry,
  harnessRefusal,
  ingestCodexLine,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  resolveCodexBinary,
  tomlString,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCodex = path.join(here, "fake-codex.js");
const fixtures = path.join(here, "fixtures", "codex");

function setup(agents = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-codex-"));
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
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe "brief".\n`);
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
  return { root, project: realpathSync(project), config, runs, codex, recorded, cleanup };
}

const base = { cwd: "/w", prompt: "p", sessionId: "11111111-2222-4333-8444-555555555555" };

test("argv: exec --json, user config and rules ignored, sandbox per mode, network off, prompt on stdin", () => {
  const codex = new CodexExecutor({ binary: fakeCodex });
  const dontAsk = codex.buildArgv({ ...base, permissionMode: "dontAsk" });
  assert.deepEqual(dontAsk, [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "-s",
    "read-only",
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-",
  ]);
  const edits = codex.buildArgv({
    ...base,
    permissionMode: "acceptEdits",
    model: "gpt-5.1-codex-mini",
    effort: "low",
    appendSystemPrompt: 'Say "hi".\nUse C:\\tmp.',
  });
  const pairs = (f) => edits.flatMap((a, i) => (a === f ? [edits[i + 1]] : []));
  assert.deepEqual(pairs("-s"), ["workspace-write"]);
  assert.deepEqual(pairs("-m"), ["gpt-5.1-codex-mini"]);
  assert.deepEqual(pairs("-c"), [
    "sandbox_workspace_write.network_access=false",
    'model_reasoning_effort="low"',
    'developer_instructions="Say \\"hi\\".\\nUse C:\\\\tmp."',
  ]);
  assert.equal(edits.at(-1), "-", "the prompt comes from stdin");
  for (const argv of [dontAsk, edits]) {
    for (const never of [
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "danger-full-access",
      "--skip-git-repo-check",
      "resume",
    ])
      assert.ok(!argv.includes(never), `${never} is never passed`);
    assert.ok(!argv.includes("p"), "the prompt is not in argv");
    assert.ok(!argv.some((a) => a.includes("\n")), "no raw newline in argv");
  }
  assert.throws(() => codex.buildArgv({ ...base, permissionMode: "plan" }), /permission_mode plan/);
  assert.throws(
    () => codex.buildArgv({ ...base, permissionMode: "dontAsk", resumeSessionId: base.sessionId }),
    /resuming a session is not supported by harness codex/,
  );
});

test("tomlString: quotes, backslashes and control characters are escaped", () => {
  assert.equal(tomlString("plain"), '"plain"');
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(tomlString("l1\nl2\r\tx"), '"l1\\nl2\\r\\tx"');
  assert.equal(tomlString("bell\u0007del\u007f"), '"bell\\u0007del\\u007f"');
  assert.equal(tomlString("é ✓"), '"é ✓"', "non-ASCII stays as written");
});

test("every field Codex cannot honour is refused, by name", () => {
  const cases = [
    [{ allowed_tools: ["Bash(ls)"] }, "allowed_tools"],
    [{ disallowed_tools: ["Write"] }, "disallowed_tools"],
    [{ on_failure: "resume_once" }, "on_failure: resume_once"],
    [{ max_budget_usd: 1 }, "max_budget_usd"],
    [{ wrap_up_reserve_usd: 0 }, "wrap_up_reserve_usd"],
    [{ resume_budget_usd: 1 }, "resume_budget_usd"],
    [{ max_daily_cost_usd: 1 }, "max_daily_cost_usd"],
    [{ claude_agent: "x" }, "claude_agent"],
    [{ inherit_mcp: true }, "inherit_mcp"],
    [{ add_dirs: ["/tmp"] }, "add_dirs"],
    [{ skills: ["s"] }, "skills"],
    [{ sandbox: true }, "sandbox"],
    [{ sandbox_allowed_domains: ["x.org"] }, "sandbox_allowed_domains"],
  ];
  for (const [fields, name] of cases) {
    assert.equal(
      harnessRefusal({ harness: "codex", ...fields }, builtinHarnesses),
      `${name} is not supported by harness codex`,
    );
  }
  for (const mode of ["plan", "auto", "default", "bypassPermissions"]) {
    assert.match(harnessRefusal({ harness: "codex", permission_mode: mode }, builtinHarnesses), /^permission_mode /);
  }
  for (const fine of [{ permission_mode: "dontAsk" }, { permission_mode: "acceptEdits" }, { effort: "high" }, {}]) {
    assert.equal(harnessRefusal({ harness: "codex", ...fine }, builtinHarnesses), null);
  }
  assert.equal(CODEX_CAPABILITIES.reportsCostUsd, false);
  assert.equal(CODEX_CAPABILITIES.projectAgents, false, "nothing in the CLI loads an agent from a project");
  const codex = new CodexExecutor({ binary: fakeCodex });
  assert.throws(() => codex.prepare({ ...base, permissionMode: "dontAsk", allowedTools: ["x"] }), /allowed_tools/);
});

test("binary: CODEX_BIN, then codex.binary, then PATH; a missing path is null; never passed to a run", () => {
  const missing = path.join(here, "no-such-codex");
  assert.equal(process.env.CODEX_BIN, fakeCodex, "helpers.js points every test at the double");
  assert.equal(resolveCodexBinary(missing), fakeCodex, "CODEX_BIN wins over codex.binary");
  assert.equal(resolveCodexBinary(fakeCodex, { PATH: "" }), fakeCodex);
  assert.equal(resolveCodexBinary(missing, { PATH: "" }), null);
  assert.equal(resolveCodexBinary(null, { PATH: here, CODEX_BIN: missing }), null);
  assert.equal(childEnv(["CODEX_*"], { PATH: "/usr/bin", CODEX_BIN: fakeCodex }).CODEX_BIN, undefined);
  assert.equal(childEnv(["CODEX_*"], { PATH: "/usr/bin", CODEX_HOME: "/h" }).CODEX_HOME, "/h");
  assert.equal(childEnv([], { PATH: "/usr/bin", OPENAI_API_KEY: "x" }).OPENAI_API_KEY, undefined);
});

function parse(name) {
  const state = createCodexState();
  const events = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => ingestCodexLine(state, l));
  return { state, events };
}

test("parser: the edit fixture gives the thread id, the command, the final text and the usage", () => {
  const { state, events } = parse("edit");
  const init = events.filter((e) => e.type === "init");
  assert.equal(init.length, 1);
  assert.equal(init[0].sessionId, "01a1f616-dda1-7da0-adb2-81638c8f87ec");
  assert.equal(init[0].model, null, "the stream names no model");
  assert.equal(state.toolCalls, 1, "item.started and item.completed are one call");
  const bash = events.find((e) => e.type === "bash_result");
  assert.match(bash.command, /hello\.txt/);
  assert.equal(bash.output, "hello.\n");
  assert.equal(bash.isError, false);
  assert.equal(state.lastAssistantText, "Created `hello.txt` containing the single line `hello.`");
  assert.equal(state.turnEnd.kind, "completed");
  assert.deepEqual(state.usage, {
    inputTokens: 33451 - 27392,
    outputTokens: 73,
    cacheReadTokens: 27392,
    cacheCreationTokens: 0,
  });
});

test("parser: patch, sandbox-blocked commands, failed model, killed, unknown and broken lines", () => {
  const patch = parse("codex-home-patch");
  assert.equal(patch.state.toolCalls, 3);
  const change = patch.events.find((e) => e.type === "tool_use" && e.name === "file_change");
  assert.deepEqual(change.input, { changes: [{ path: "/work/hello.txt", kind: "update" }] });

  for (const name of ["readonly-write", "network-blocked"]) {
    const { state, events } = parse(name);
    const bash = events.find((e) => e.type === "bash_result");
    assert.equal(bash.isError, true, `${name}: a failed command`);
    assert.equal(state.turnEnd.kind, "completed", `${name}: the run itself completes`);
    assert.ok(!events.some((e) => e.type === "sandbox_violation"), `${name}: the sandbox is never guessed from text`);
  }

  const failed = parse("failed-model");
  assert.equal(failed.state.turnEnd.kind, "failed");
  assert.match(failed.state.turnEnd.error, /'no-such-model' model is not supported/);

  const killed = parse("killed");
  assert.equal(killed.state.turnEnd, null);
  assert.ok(killed.state.threadId);

  const resumed = parse("resume");
  assert.equal(resumed.state.threadId, "01a1f616-dda1-7da0-adb2-81638c8f87ec", "resume keeps the thread id");

  assert.equal(parse("stdin").state.lastAssistantText, "stdin works");

  const state = createCodexState();
  assert.deepEqual(ingestCodexLine(state, '{"type":"some.future_event"}'), []);
  assert.deepEqual(ingestCodexLine(state, '{"type":"item.completed","item":{"id":"r","type":"reasoning"}}'), []);
  assert.deepEqual(ingestCodexLine(state, "not json"), [{ type: "parse_error", line: "not json" }]);
});

test("a run through RunManager: completed, unpriced, persona and prompt delivered, thread id kept", async () => {
  const t = setup({ helper: "harness: codex\npermission_mode: acceptEdits\nmodel: gpt-5.1-codex-mini" });
  try {
    const started = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:edit" });
    assert.equal(started.harness, "codex");
    const run = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(run.costUsd, null);
    assert.equal(run.costStatus, "unpriced");
    assert.equal(run.toolCalls, 1);
    assert.equal(run.claudeSessionId, "01a1f616-dda1-7da0-adb2-81638c8f87ec", "Codex's thread id is the session");
    assert.equal(run.inputTokens, 33451 - 27392);
    assert.deepEqual(run.reviewReasons, []);

    const rec = t.recorded();
    assert.equal(rec.prompt, "fixture:edit", "the prompt went on stdin");
    assert.ok(!rec.argv.includes("fixture:edit"));
    assert.ok(rec.argv.includes('developer_instructions="Be \\"brief\\"."'), "the agent body is the persona");
    assert.ok(rec.argv.includes("workspace-write"));
    assert.ok(!rec.env.includes("CODEX_BIN"));
  } finally {
    t.cleanup();
  }
});

test("an unknown model fails with Codex's message; a dontAsk agent runs read-only", async () => {
  const t = setup({ helper: "harness: codex\npermission_mode: dontAsk" });
  try {
    const bad = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:failed-model" });
    const failed = await t.runs.waitForRun(bad.id, 15_000);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /'no-such-model' model is not supported/);
    const argv = t.recorded().argv;
    assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  } finally {
    t.cleanup();
  }
});

test("cancel ends the run cancelled; silence past the inactivity limit ends it timed_out", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "duskfleet-codex-exec-"));
  try {
    const codex = new CodexExecutor({ binary: fakeCodex });
    let handle = null;
    let cancelled = false;
    handle = codex.execute({ ...base, cwd, prompt: "fixture:killed", permissionMode: "dontAsk" }, () => {
      if (cancelled || !handle) return;
      cancelled = true;
      handle.cancel();
    });
    const killed = await handle.done;
    assert.equal(killed.outcome, "cancelled");
    assert.equal(killed.terminationReason, "cancelled");
    assert.equal(killed.sessionId, "01a1f617-c6d0-7c60-afd6-20cde1649506");

    // Long enough for the double to start under a loaded test run, short enough for the suite.
    const quiet = new CodexExecutor({ binary: fakeCodex, inactivityMs: 3_000 });
    const stalled = await quiet.execute({ ...base, cwd, prompt: "fixture:killed", permissionMode: "dontAsk" }).done;
    assert.equal(stalled.outcome, "timed_out");
    assert.match(stalled.error, /no output from codex/);

    const done = await quiet.execute({ ...base, cwd, prompt: "fixture:stdin", permissionMode: "dontAsk" }).done;
    assert.equal(done.outcome, "completed", "a finished turn disarms the inactivity timer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
