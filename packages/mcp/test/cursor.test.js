/**
 * The Cursor Agent CLI harness (issue #467). fake-cursor.js replays the real runs captured in
 * fixtures/cursor/ (Cursor Agent CLI 2026.11.19 / 2026.11.22); the real CLI is never launched.
 * Covers the argv, the per-agent cli-config.json (rules verbatim, Write(**) under dontAsk, MCP
 * always denied), the body as a marked block ahead of the task, every field Cursor cannot honour
 * refused by name, the parser on the fixtures (denials, subagents), and runs through RunManager
 * (completed unpriced, failed, cancelled, continued, an unknown session started fresh).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import {
  builtinHarnesses,
  ClaudeCodeExecutor,
  CURSOR_CAPABILITIES,
  CursorExecutor,
  childEnv,
  createCursorState,
  cursorPermissions,
  cursorPrompt,
  cursorRuleRefusal,
  cursorSessionExists,
  HarnessRegistry,
  harnessRefusal,
  ingestCursorLine,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  resolveCursorBinary,
  SHIPPED_HARNESSES,
  writeCursorConfig,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCursor = path.join(here, "fake-cursor.js");
const fixtures = path.join(here, "fixtures", "cursor");
const sessionOf = (name) =>
  /"session_id":"([^"]+)"/.exec(readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8"))[1];

function setup(agents = {}, cursorOptions = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-cursor-"));
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
      '  env_passthrough: ["FAKE_CURSOR_*"]',
      "cursor:",
      `  binary: "${fakeCursor}"`,
      "",
    ].join("\n"),
  );
  for (const [id, frontmatter] of Object.entries(agents)) {
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe brief.\n`);
  }
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const claude = new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const configRoot = path.join(config.dataDir, "cursor");
  const cursor = new CursorExecutor({ binary: config.cursor.binary, configRoot, ...cursorOptions });
  const runs = new RunManager(config, new RunRepository(db), new HarnessRegistry([claude, cursor]));
  process.env.FAKE_CURSOR_RECORD = record;
  const cleanup = () => {
    delete process.env.FAKE_CURSOR_RECORD;
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  const recorded = () => JSON.parse(readFileSync(record, "utf8"));
  return { root, project: realpathSync(project), config, configRoot, runs, cursor, recorded, cleanup };
}

const base = { cwd: "/w", prompt: "p", sessionId: "11111111-2222-4333-8444-555555555555" };

test("argv: print mode, stream-json, --trust, model, resume and add-dir; never --force, --approve-mcps or --sandbox", () => {
  const cursor = new CursorExecutor({ binary: fakeCursor, configRoot: "/unused" });
  assert.deepEqual(cursor.buildArgv({ ...base, permissionMode: "dontAsk" }), [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
  ]);
  const full = cursor.buildArgv({
    ...base,
    permissionMode: "acceptEdits",
    model: "auto",
    resumeSessionId: "abc",
    addDirs: ["/a", "/b"],
  });
  assert.deepEqual(full.slice(4), ["--model", "auto", "--resume", "abc", "--add-dir", "/a", "--add-dir", "/b"]);
  for (const never of ["--force", "--yolo", "--approve-mcps", "--sandbox", "p"])
    assert.ok(!full.includes(never), `${never} is never passed`);
  assert.throws(() => cursor.buildArgv({ ...base, permissionMode: "plan" }), /permission_mode plan/);
});

test("permissions: rules verbatim, Write(**) denied under dontAsk, Mcp(*:*) always denied; the CLI's own keys kept", () => {
  assert.deepEqual(cursorPermissions({ permissionMode: "dontAsk", allowedTools: ["Shell(git)", "Read(**)"] }), {
    allow: ["Shell(git)", "Read(**)"],
    deny: ["Write(**)", "Mcp(*:*)"],
  });
  assert.deepEqual(cursorPermissions({ permissionMode: "acceptEdits", disallowedTools: ["Shell(rm)"] }), {
    allow: [],
    deny: ["Shell(rm)", "Mcp(*:*)"],
  });
  const dir = mkdtempSync(path.join(tmpdir(), "duskfleet-cursor-cfg-"));
  try {
    writeFileSync(
      path.join(dir, "cli-config.json"),
      JSON.stringify({ authInfo: { email: "me" }, permissions: { allow: ["Shell(rm)"], deny: [] }, approvalMode: "x" }),
    );
    writeCursorConfig(dir, { allow: ["Shell(ls)"], deny: ["Mcp(*:*)"] });
    const written = JSON.parse(readFileSync(path.join(dir, "cli-config.json"), "utf8"));
    assert.deepEqual(written.permissions, { allow: ["Shell(ls)"], deny: ["Mcp(*:*)"] }, "replaced, never merged");
    assert.equal(written.approvalMode, "allowlist");
    assert.deepEqual(written.authInfo, { email: "me" }, "the CLI's own login block stays");
    assert.equal(cursorSessionExists(dir, "s1"), false);
    mkdirSync(path.join(dir, "chats", "h", "s1"), { recursive: true });
    assert.equal(cursorSessionExists(dir, "s1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the body is a marked block ahead of the task; no body, no block", () => {
  assert.equal(cursorPrompt("do it", undefined), "do it");
  assert.equal(cursorPrompt("do it", "  "), "do it");
  const p = cursorPrompt("do it", "You are terse.\n");
  assert.match(p, /^<duskfleet-agent-instructions>\nYou are terse\.\n<\/duskfleet-agent-instructions>\n\n/);
  assert.match(p, /<duskfleet-task>\ndo it\n<\/duskfleet-task>$/);
});

test("capabilities: Cursor rules only, no MCP rule, no budget, effort, sandbox, skills, inherit_mcp or link", () => {
  assert.equal(builtinHarnesses("cursor"), CURSOR_CAPABILITIES);
  assert.ok(SHIPPED_HARNESSES.includes("cursor"));
  const ok = { harness: "cursor", permission_mode: "dontAsk", allowed_tools: ["Shell(git)", "Read(src/**)"] };
  assert.equal(harnessRefusal(ok, builtinHarnesses), null);
  assert.equal(harnessRefusal({ harness: "cursor", add_dirs: ["/x"] }, builtinHarnesses), null);
  for (const rule of ["Bash(git:*)", "Read", "mcp__x", "shell(git)"])
    assert.match(harnessRefusal({ harness: "cursor", allowed_tools: [rule] }, builtinHarnesses), /not a Cursor/);
  assert.match(
    harnessRefusal({ harness: "cursor", allowed_tools: ["Mcp(srv:tool)"] }, builtinHarnesses),
    /MCP rule/,
    "an Mcp() entry is refused by name",
  );
  assert.equal(cursorRuleRefusal("WebFetch(github.com)"), null);
  for (const [fields, named] of [
    [{ max_budget_usd: 1 }, "max_budget_usd"],
    [{ max_daily_cost_usd: 1 }, "max_daily_cost_usd"],
    [{ effort: "low" }, "effort"],
    [{ sandbox: true }, "sandbox"],
    [{ skills: ["s"] }, "skills"],
    [{ inherit_mcp: true }, "inherit_mcp"],
    [{ claude_agent: "x" }, "claude_agent"],
    [{ codex_network: true }, "codex_network"],
  ]) {
    const why = harnessRefusal({ harness: "cursor", ...fields }, builtinHarnesses);
    assert.ok(why?.startsWith(`${named} is not supported by harness cursor`), `${named}: ${why}`);
  }
  for (const mode of ["plan", "bypassPermissions", "default"])
    assert.match(harnessRefusal({ harness: "cursor", permission_mode: mode }, builtinHarnesses), /^permission_mode /);
});

test("binary: CURSOR_BIN wins, a missing path is null; childEnv never passes CURSOR_BIN", () => {
  assert.equal(resolveCursorBinary(null, { CURSOR_BIN: fakeCursor }), fakeCursor);
  assert.equal(resolveCursorBinary(null, { CURSOR_BIN: "/no/such/cursor-agent" }), null);
  assert.equal(resolveCursorBinary("/no/such/cursor-agent", { PATH: "" }), null);
  assert.equal(childEnv([]).CURSOR_BIN, undefined);
  assert.equal(childEnv(["CURSOR_*"]).CURSOR_BIN, undefined);
});

function parse(name) {
  const state = createCursorState();
  const events = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => ingestCursorLine(state, l));
  return { state, events };
}

test("parser: init, final text from the last assistant line, usage, denials and subagents", () => {
  const edit = parse("edit");
  assert.equal(edit.state.sessionId, sessionOf("edit"));
  assert.equal(edit.state.model, "Auto");
  assert.ok(edit.state.result, "a result line");
  assert.equal(edit.state.permissionDenials, 0);
  assert.ok(edit.state.toolCalls >= 1);
  assert.equal(typeof edit.state.usage.inputTokens, "number");
  assert.notEqual(edit.state.lastAssistantText, edit.state.result.result, "never the joined result text");

  const denied = parse("shell-denied");
  assert.equal(denied.state.toolCalls, 3);
  assert.equal(denied.state.permissionDenials, 3);
  assert.deepEqual(denied.state.deniedTools[0], { tool: "shellToolCall", summary: "git status --short ." });
  assert.ok(denied.events.filter((e) => e.type === "bash_result").every((e) => e.isError));

  const allowed = parse("shell-allowed");
  const bash = allowed.events.find((e) => e.type === "bash_result");
  assert.equal(bash.isError, false);
  assert.match(bash.output, /hello\.txt/);

  assert.ok(parse("write-denied").state.deniedTools.some((d) => d.tool === "editToolCall"));
  const mcp = parse("mcp-denied").state;
  assert.ok(
    mcp.deniedTools.some((d) => d.tool === "mcpToolCall"),
    "a blocked MCP call is a denial",
  );
  assert.ok(parse("mcp-no-rule").state.deniedTools.some((d) => d.tool === "mcpToolCall"));
  assert.equal(parse("mcp-allowed").state.permissionDenials, 0);

  const sub = parse("subagent");
  assert.equal(sub.state.subagents.length, 1);
  assert.equal(sub.state.subagents[0].subagentType, "parrot");
  assert.equal(sub.state.subagents[0].status, "completed");
  assert.equal(sub.state.subagents[0].resultText, "SQUAWK");
  assert.equal(sub.state.subagents[0].durationMs, 2498);
  assert.ok(sub.events.some((e) => e.type === "subagent_start"));

  const state = createCursorState();
  assert.deepEqual(ingestCursorLine(state, '{"type":"thinking","subtype":"delta","text":"x"}'), []);
  assert.deepEqual(ingestCursorLine(state, "not json"), [{ type: "parse_error", line: "not json" }]);
});

test("a run through RunManager: completed, unpriced, body ahead of the task, per-agent config, session kept", async () => {
  const t = setup({
    helper: 'harness: cursor\npermission_mode: dontAsk\nmodel: auto\nallowed_tools: ["Shell(git)"]',
  });
  try {
    const started = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:edit" });
    assert.equal(started.harness, "cursor");
    const run = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(run.costUsd, null);
    assert.equal(run.costStatus, "unpriced");
    assert.equal(run.claudeSessionId, sessionOf("edit"), "Cursor's session id is the session");

    const rec = t.recorded();
    assert.equal(rec.prompt, cursorPrompt("fixture:edit", "Be brief.\n"), "body block, then the task, on stdin");
    assert.ok(!rec.argv.some((a) => a.includes("fixture:edit")));
    assert.equal(rec.configDir, path.join(t.configRoot, "helper"), "one configuration directory per agent");
    assert.ok(!rec.configDir.startsWith(t.project), "never in the project");
    assert.deepEqual(rec.config.permissions, { allow: ["Shell(git)"], deny: ["Write(**)", "Mcp(*:*)"] });
    assert.ok(!rec.env.includes("CURSOR_BIN"));
  } finally {
    t.cleanup();
  }
});

test("an untrusted-folder or unknown-model start fails with the CLI's stderr", async () => {
  const t = setup({ helper: "harness: cursor\npermission_mode: acceptEdits" });
  try {
    const bad = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:failed-model" });
    const failed = await t.runs.waitForRun(bad.id, 15_000);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /no result line received \(exit 1/);
    assert.match(failed.error, /Cannot use this model/);
    assert.deepEqual(t.recorded().config.permissions.deny, ["Mcp(*:*)"], "acceptEdits adds no Write deny");
  } finally {
    t.cleanup();
  }
});

test("cancel ends the run cancelled; silence past the inactivity limit ends it timed_out", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "duskfleet-cursor-exec-"));
  try {
    const cursor = new CursorExecutor({ binary: fakeCursor, configRoot: path.join(cwd, "cfg") });
    let handle = null;
    let cancelled = false;
    handle = cursor.execute({ ...base, cwd, prompt: "fixture:killed", permissionMode: "dontAsk", agentId: "a" }, () => {
      if (cancelled || !handle) return;
      cancelled = true;
      handle.cancel();
    });
    const killed = await handle.done;
    assert.equal(killed.outcome, "cancelled");
    assert.equal(killed.sessionId, sessionOf("killed"));

    const quiet = new CursorExecutor({ binary: fakeCursor, configRoot: path.join(cwd, "cfg"), inactivityMs: 3_000 });
    const stalled = await quiet.execute({ ...base, cwd, prompt: "fixture:killed", permissionMode: "dontAsk" }).done;
    assert.equal(stalled.outcome, "timed_out");
    assert.match(stalled.error, /no output from cursor-agent/);

    const done = await quiet.execute({ ...base, cwd, prompt: "fixture:stdin", permissionMode: "dontAsk" }).done;
    assert.equal(done.outcome, "completed", "a result line disarms the inactivity timer");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const notes = (runs, runId) =>
  runs
    .events(runId)
    .filter((e) => e.type === "note")
    .map((e) => e.payload);

test("a continued Cursor run resumes its session; a session the config directory lacks starts fresh, nothing spawned", async () => {
  const t = setup({ helper: "harness: cursor\npermission_mode: acceptEdits" });
  try {
    const first = await t.runs.waitForRun(
      (await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:edit" })).id,
      15_000,
    );
    assert.equal(first.status, "completed");

    const next = await t.runs.waitForRun(
      (await t.runs.continueRun({ runId: first.id, prompt: "what did you do earlier?" })).id,
      15_000,
    );
    assert.equal(next.status, "completed");
    assert.equal(next.continuedFromRunId, first.id);
    assert.equal(next.claudeSessionId, first.claudeSessionId);
    const argv = t.recorded().argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], first.claudeSessionId);
    assert.match(t.recorded().prompt, /<duskfleet-agent-instructions>/, "the body is sent again on a resume");

    // The CLI would start an empty session under the same id without a word: Duskfleet looks first.
    rmSync(path.join(t.configRoot, "helper", "chats"), { recursive: true, force: true });
    const fresh = await t.runs.waitForRun(
      (await t.runs.continueRun({ runId: first.id, prompt: "fixture:stdin" })).id,
      15_000,
    );
    assert.equal(fresh.status, "completed");
    assert.equal(fresh.continuedFromRunId, null, "not a continuation once the session was unknown");
    assert.ok(notes(t.runs, fresh.id).some((n) => n.notContinuedFromRunId === first.id));
    assert.ok(!t.recorded().argv.includes("--resume"), "the fallback is a fresh session");
    assert.ok(existsSync(path.join(t.configRoot, "helper", "chats")));
  } finally {
    t.cleanup();
  }
});
