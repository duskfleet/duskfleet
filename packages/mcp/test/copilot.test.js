/**
 * The GitHub Copilot CLI harness (issue #446). fake-copilot.js replays the real runs captured in
 * fixtures/copilot/ (Copilot CLI 1.0.112); the real CLI is never launched. Covers the argv per
 * permission mode, native rules passed verbatim and Claude-shaped ones refused by name, every
 * field Copilot cannot honour refused by name, the environment, the parser on each fixture, and
 * runs through RunManager (completed unpriced, needs review on a denial, failed, resumed, cancelled).
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
  COPILOT_CAPABILITIES,
  COPILOT_PERSONA_AGENT,
  CopilotExecutor,
  copilotEnv,
  copilotUsageByModel,
  createCopilotState,
  HarnessRegistry,
  harnessRefusal,
  ingestCopilotLine,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
  resolveCopilotBinary,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");
const fakeCopilot = path.join(here, "fake-copilot.js");
const fixtures = path.join(here, "fixtures", "copilot");

function setup(agents = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-copilot-"));
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
      '  env_passthrough: ["FAKE_COPILOT_*"]',
      "copilot:",
      `  binary: "${fakeCopilot}"`,
      "",
    ].join("\n"),
  );
  for (const [id, frontmatter] of Object.entries(agents)) {
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe brief.\n`);
  }
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const claude = new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const copilot = new CopilotExecutor({ binary: config.copilot.binary });
  const runs = new RunManager(config, new RunRepository(db), new HarnessRegistry([claude, copilot]));
  process.env.FAKE_COPILOT_RECORD = record;
  const cleanup = () => {
    delete process.env.FAKE_COPILOT_RECORD;
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  const recorded = () => JSON.parse(readFileSync(record, "utf8"));
  return { root, project: realpathSync(project), config, runs, copilot, recorded, cleanup };
}

const base = { cwd: "/w", prompt: "p", sessionId: "11111111-2222-4333-8444-555555555555" };

test("argv: deny by default, acceptEdits adds write, rules verbatim, never a trust or allow-all flag", () => {
  const copilot = new CopilotExecutor({ binary: fakeCopilot });
  const dontAsk = copilot.buildArgv({ ...base, permissionMode: "dontAsk", allowedTools: ["shell(git)"] }, "/tmp/w");
  assert.deepEqual(dontAsk, [
    "--output-format",
    "json",
    "--no-ask-user",
    "--no-auto-update",
    "--disable-builtin-mcps",
    "--session-id",
    base.sessionId,
    "--allow-tool",
    "shell(git)",
    "--usage-output-file",
    path.join("/tmp/w", "usage.json"),
  ]);
  const edits = copilot.buildArgv(
    {
      ...base,
      permissionMode: "acceptEdits",
      model: "claude-haiku-4.5",
      effort: "low",
      allowedTools: ["shell(ls)", "url(github.com)"],
      disallowedTools: ["shell(rm)"],
      appendSystemPrompt: "You are terse.",
      resumeSessionId: base.sessionId,
    },
    "/tmp/w",
  );
  assert.ok(edits.includes(`--resume=${base.sessionId}`), "resume as one argument");
  assert.ok(!edits.includes("--session-id"), "a resumed run sets no new session id");
  const pairs = (f) => edits.flatMap((a, i) => (a === f ? [edits[i + 1]] : []));
  assert.deepEqual(pairs("--allow-tool"), ["write", "shell(ls)", "url(github.com)"]);
  assert.deepEqual(pairs("--deny-tool"), ["shell(rm)"]);
  assert.deepEqual(pairs("--model"), ["claude-haiku-4.5"]);
  assert.deepEqual(pairs("--reasoning-effort"), ["low"]);
  assert.deepEqual(pairs("--add-dir"), ["/tmp/w"], "the persona's temp directory only");
  assert.deepEqual(pairs("--agent"), [COPILOT_PERSONA_AGENT]);
  for (const argv of [dontAsk, edits]) {
    for (const never of [
      "-p",
      "--prompt",
      "--trust-folder",
      "--allow-all-tools",
      "--allow-all",
      "--yolo",
      "--autopilot",
    ])
      assert.ok(!argv.includes(never), `${never} is never passed`);
    assert.ok(!argv.includes("p"), "the prompt is not in argv");
  }
  assert.throws(() => copilot.buildArgv({ ...base, permissionMode: "plan" }, "/tmp/w"), /permission_mode plan/);
});

test("rules: Copilot's own pass, Claude-shaped ones are refused by name at create and at run start", () => {
  const ok = {
    harness: "copilot",
    allowed_tools: ["shell", "shell(gh pr)", "write", "read(src)", "url(x.org)", "memory"],
  };
  assert.equal(harnessRefusal(ok, builtinHarnesses), null, "builtinHarnesses knows copilot: create / update accept it");
  for (const rule of ["Bash(git:*)", "Read", "Edit", "mcp__claude_ai_Figma", "github(get_issue)", "shell()"]) {
    assert.match(
      harnessRefusal({ harness: "copilot", allowed_tools: [rule] }, builtinHarnesses),
      new RegExp(`^allowed_tools entry "${rule.replace(/[()*]/g, "\\$&")}" is not a Copilot tool rule`),
    );
  }
  assert.match(
    harnessRefusal({ harness: "copilot", disallowed_tools: ["Write"] }, builtinHarnesses),
    /^disallowed_tools entry "Write" is not a Copilot tool rule/,
  );
  const copilot = new CopilotExecutor({ binary: fakeCopilot });
  assert.throws(
    () => copilot.prepare({ ...base, permissionMode: "dontAsk", allowedTools: ["Bash(ls)"] }),
    /allowed_tools entry "Bash\(ls\)"/,
  );
});

test("every field Copilot cannot honour is refused, by name", () => {
  const cases = [
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
      harnessRefusal({ harness: "copilot", ...fields }, builtinHarnesses),
      `${name} is not supported by harness copilot`,
    );
  }
  for (const mode of ["plan", "auto", "default", "bypassPermissions"]) {
    assert.match(harnessRefusal({ harness: "copilot", permission_mode: mode }, builtinHarnesses), /^permission_mode /);
  }
  for (const fine of [{ permission_mode: "dontAsk" }, { effort: "high" }, { on_failure: "resume_once" }]) {
    assert.equal(harnessRefusal({ harness: "copilot", ...fine }, builtinHarnesses), null);
  }
  assert.equal(COPILOT_CAPABILITIES.reportsCostUsd, false);
});

test("COPILOT_ALLOW_ALL never reaches the child, even through an env_passthrough", () => {
  const env = copilotEnv(["COPILOT_*"], { PATH: "/usr/bin", COPILOT_ALLOW_ALL: "true", COPILOT_HOME: "/h" });
  assert.equal(env.COPILOT_ALLOW_ALL, undefined);
  assert.equal(env.COPILOT_HOME, "/h", "the rest of the passthrough stands");
  assert.equal(copilotEnv([], { PATH: "/usr/bin", COPILOT_HOME: "/h", GITHUB_TOKEN: "x" }).GITHUB_TOKEN, undefined);
});

test("on Windows a mixed-case Copilot_Allow_All is the same variable and is dropped too", () => {
  const source = { Path: "C:\\bin", Copilot_Allow_All: "true", Copilot_Home: "C:\\h" };
  const env = copilotEnv(["COPILOT_ALLOW_ALL", "COPILOT_HOME"], source, "win32");
  assert.equal(env.Copilot_Allow_All, undefined);
  assert.ok(!Object.keys(env).some((k) => k.toUpperCase() === "COPILOT_ALLOW_ALL"));
  assert.equal(env.Copilot_Home, "C:\\h", "the rest of the passthrough stands");
});

test("binary: COPILOT_BIN, then copilot.binary, then PATH; a missing path is null", () => {
  const missing = path.join(here, "no-such-copilot");
  assert.equal(process.env.COPILOT_BIN, fakeCopilot, "helpers.js points every test at the double");
  assert.equal(resolveCopilotBinary(missing), fakeCopilot, "COPILOT_BIN wins over copilot.binary");
  assert.equal(resolveCopilotBinary(fakeCopilot, { PATH: "" }), fakeCopilot);
  assert.equal(resolveCopilotBinary(missing, { PATH: "" }), null);
  assert.equal(resolveCopilotBinary(null, { PATH: here, COPILOT_BIN: missing }), null);
  assert.equal(copilotEnv([], { PATH: "/usr/bin", COPILOT_BIN: fakeCopilot }).COPILOT_BIN, undefined, "never passed");
});

function parse(name) {
  const state = createCopilotState();
  const events = readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8")
    .split("\n")
    .flatMap((l) => ingestCopilotLine(state, l));
  return { state, events };
}

test("parser: the edit fixture gives init, the tool call, the final text and the result line", () => {
  const { state, events } = parse("edit");
  const init = events.find((e) => e.type === "init");
  assert.equal(init.model, "claude-haiku-4.5");
  assert.equal(init.cliVersion, "1.0.112");
  assert.ok(init.sessionId);
  assert.ok(init.mcpServers.every((s) => s.status === "disabled"));
  assert.equal(events.filter((e) => e.type === "init").length, 1);
  assert.ok(events.some((e) => e.type === "tool_use" && e.name === "create"));
  assert.equal(state.toolCalls, 1);
  assert.equal(state.result.exitCode, 0);
  assert.ok(state.lastAssistantText?.trim());
  assert.ok(!events.some((e) => e.type === "parse_error"), "status lines are ignored, not parse errors");
  const usage = copilotUsageByModel(JSON.parse(readFileSync(path.join(fixtures, "edit.usage.json"), "utf8")));
  assert.deepEqual(usage, {
    "claude-haiku-4.5": { inputTokens: 33377, outputTokens: 178, cacheReadTokens: 16558, cacheCreationTokens: 16803 },
  });
});

test("parser: shell result, denial, session error, cancellation, unknown and broken lines", () => {
  const shell = parse("shell");
  const bash = shell.events.find((e) => e.type === "bash_result");
  assert.equal(bash.command, "ls -la .");
  assert.equal(bash.isError, false);
  assert.match(bash.output, /README\.md/);

  const denied = parse("denied");
  assert.equal(denied.state.permissionDenials, 1);
  assert.deepEqual(denied.state.deniedTools, [{ tool: "bash", summary: "touch marker.txt" }]);
  assert.equal(denied.state.result.exitCode, 0, "a denial does not change the exit code");

  const failed = parse("failed-model");
  assert.match(failed.state.error.message, /Model "no-such-model" is not available/);
  assert.equal(failed.state.result.exitCode, 1);

  assert.equal(parse("killed").state.cancelled, true);
  const resumed = parse("resume");
  assert.ok(
    resumed.events.some((e) => e.type === "init"),
    "session.resume starts the session too",
  );

  const state = createCopilotState();
  assert.deepEqual(ingestCopilotLine(state, '{"type":"some.future_event","data":{}}'), []);
  assert.deepEqual(ingestCopilotLine(state, "not json"), [{ type: "parse_error", line: "not json" }]);
});

test("a run through RunManager: completed, unpriced, persona delivered, temp directory removed", async () => {
  const t = setup({ helper: "harness: copilot\nallowed_tools: [write]" });
  try {
    const started = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:edit" });
    assert.equal(started.harness, "copilot");
    const run = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(run.costUsd, null);
    assert.equal(run.costStatus, "unpriced", "premium requests are not dollars");
    assert.equal(run.toolCalls, 1);
    assert.equal(run.modelUsed, "claude-haiku-4.5");
    assert.equal(run.claudeCodeVersion, "1.0.112");
    assert.equal(run.claudeSessionId, started.claudeSessionId, "--session-id is honoured");
    assert.equal(run.inputTokens, 33377, "tokens from the usage file");
    assert.deepEqual(run.reviewReasons, []);

    const rec = t.recorded();
    assert.equal(rec.prompt, "fixture:edit", "the prompt went on stdin");
    assert.ok(!rec.argv.includes("fixture:edit"));
    assert.match(rec.persona, /^---\nname: duskfleet-agent\n/);
    assert.match(rec.persona, /Be brief\./, "the agent body is the persona");
    const addDir = rec.argv[rec.argv.indexOf("--add-dir") + 1];
    assert.ok(!existsSync(addDir), "the per-run directory is removed when the run ends");
  } finally {
    t.cleanup();
  }
});

test("a denial is needs review; an unknown model fails; COPILOT_ALLOW_ALL stays out of the run", async () => {
  const t = setup({ helper: "harness: copilot\npermission_mode: dontAsk\nenv_passthrough: [COPILOT_*]" });
  process.env.COPILOT_ALLOW_ALL = "true";
  try {
    const denied = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:denied" });
    const run = await t.runs.waitForRun(denied.id, 15_000);
    assert.equal(run.status, "completed");
    assert.equal(run.permissionDenials, 1);
    assert.ok(run.reviewReasons.length > 0, "a denied tool is needs review");
    assert.ok(!t.recorded().env.includes("COPILOT_ALLOW_ALL"));
    assert.ok(!t.recorded().argv.includes("write"), "dontAsk: no --allow-tool write");

    const bad = await t.runs.startRun({ agentId: "helper", projectPath: t.project, prompt: "fixture:failed-model" });
    const failed = await t.runs.waitForRun(bad.id, 15_000);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /not available/);
  } finally {
    delete process.env.COPILOT_ALLOW_ALL;
    t.cleanup();
  }
});

test("resume and an unknown session; cancel ends the run cancelled", async () => {
  const copilot = new CopilotExecutor({ binary: fakeCopilot });
  const cwd = mkdtempSync(path.join(tmpdir(), "duskfleet-copilot-exec-"));
  try {
    const req = { cwd, sessionId: base.sessionId, resumeSessionId: base.sessionId, permissionMode: "dontAsk" };
    const resumed = await copilot.execute({ ...req, prompt: "fixture:resume" }).done;
    assert.equal(resumed.outcome, "completed");
    assert.equal(resumed.sessionId, base.sessionId);
    assert.equal(resumed.sessionNotFound, false);

    const unknown = await copilot.execute({ ...req, prompt: "fixture:resume-unknown" }).done;
    assert.equal(unknown.outcome, "failed");
    assert.equal(unknown.sessionNotFound, true);
    assert.match(unknown.error, /no result line/);

    let handle = null;
    let cancelled = false;
    handle = copilot.execute({ ...base, cwd, prompt: "fixture:killed", permissionMode: "dontAsk" }, () => {
      // Once the stream has started, as a timeout or a cancel would find it.
      if (cancelled || !handle) return;
      cancelled = true;
      handle.cancel();
    });
    const killed = await handle.done;
    assert.equal(killed.outcome, "cancelled");
    assert.equal(killed.terminationReason, "cancelled");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
