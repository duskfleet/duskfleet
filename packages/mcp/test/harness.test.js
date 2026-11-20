/**
 * The harness seam (issue #445): one run path, one adapter per agent CLI. A second harness
 * (fake-harness.js, reduced capabilities, no dollar costs) proves the registry, the refusal of a
 * field the harness cannot honour (at create and at start, field named, nothing written or
 * spawned), the `unpriced` path through budgets, and that its runs never reach Claude-only code.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import "./helpers.js";
import {
  agentDefinitionHash,
  BudgetError,
  builtinHarnesses,
  CLAUDE_CAPABILITIES,
  ClaudeCodeExecutor,
  createAgentFromFields,
  HarnessRegistry,
  harnessRefusal,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
} from "@duskfleet/core";
import { harnessReport } from "../dist/harness-report.js";
import { renderDoctor } from "../dist/render/index.js";
import { FAKE_CAPABILITIES, FakeHarness } from "./fake-harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "fake-claude.js");

/** A ClaudeCodeExecutor that counts what reaches it: a run of another harness must leave it at 0. */
class CountingClaude extends ClaudeCodeExecutor {
  prepares = 0;
  executes = 0;
  prepare(request, context) {
    this.prepares += 1;
    return super.prepare(request, context);
  }
  execute(request, onEvent) {
    this.executes += 1;
    return super.execute(request, onEvent);
  }
}

function setup(agents = {}, extra = []) {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-harness-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\nclaude:\n  binary: "${fakeClaude}"\n  default_max_budget_usd: 2\n`,
  );
  for (const [id, frontmatter] of Object.entries(agents)) {
    writeFileSync(path.join(configDir, "agents", `${id}.md`), `---\n${frontmatter}\n---\nBe brief.\n`);
  }
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const claude = new CountingClaude({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const fake = new FakeHarness();
  const registry = new HarnessRegistry([claude, fake, ...extra]);
  const runs = new RunManager(config, new RunRepository(db), registry);
  const cleanup = () => {
    runs.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, configDir, project: realpathSync(project), config, runs, registry, claude, fake, cleanup };
}

test("the registry: claude is the default, a bare executor counts as claude, a duplicate name is refused", () => {
  const claude = new ClaudeCodeExecutor({ binary: fakeClaude, strictMcpConfig: true, allowBypassPermissions: false });
  const registry = new HarnessRegistry([claude, new FakeHarness()]);
  assert.deepEqual(registry.names(), ["claude", "fake"]);
  assert.equal(registry.capabilities("claude"), CLAUDE_CAPABILITIES);
  assert.equal(registry.capabilities("fake").toolAllowList, false);
  assert.equal(registry.capabilities("ghost"), undefined);
  const bare = { name: "old-double", binary: "/bin/true", version: async () => "1", execute() {} };
  assert.deepEqual(new HarnessRegistry(bare).names(), ["claude"], "a test double without a harness is claude");
  assert.equal(new HarnessRegistry(bare).capabilities("claude"), CLAUDE_CAPABILITIES);
  assert.throws(() => new HarnessRegistry([claude, bare]), /two executors registered for harness "claude"/);
});

test("harnessRefusal names the field; claude accepts every field it accepted before", () => {
  const registry = new HarnessRegistry([new FakeHarness()]);
  const fake = { harness: "fake", permission_mode: "acceptEdits" };
  assert.equal(harnessRefusal(fake, registry.lookup), null);
  const cases = [
    [{ allowed_tools: ["Read"] }, /^allowed_tools is not supported by harness fake$/],
    [{ disallowed_tools: ["Edit"] }, /^disallowed_tools is not supported/],
    [
      { permission_mode: "dontAsk" },
      /^permission_mode dontAsk is not supported by harness fake \(accepted: acceptEdits\)$/,
    ],
    [{ on_failure: "resume_once" }, /^on_failure: resume_once is not supported/],
    [{ max_budget_usd: 1 }, /^max_budget_usd is not supported/],
    [{ wrap_up_reserve_usd: 0 }, /^wrap_up_reserve_usd is not supported/],
    [{ max_daily_cost_usd: 1 }, /^max_daily_cost_usd is not supported/],
    [{ inherit_mcp: true }, /^inherit_mcp is not supported/],
    [{ claude_agent: "x" }, /^claude_agent is not supported/],
    [{ add_dirs: ["/tmp"] }, /^add_dirs is not supported/],
    [{ skills: ["s"] }, /^skills is not supported/],
    [{ effort: "low" }, /^effort is not supported/],
    [{ sandbox: true }, /^sandbox is not supported/],
  ];
  for (const [extra, expected] of cases) assert.match(harnessRefusal({ ...fake, ...extra }, registry.lookup), expected);
  assert.match(
    harnessRefusal(fake, registry.lookup, { id: "p", inheritMcp: true }),
    /inherit_mcp is not supported by harness fake \(set by project p\)/,
  );
  assert.match(harnessRefusal({ harness: "ghost" }, registry.lookup), /unknown harness "ghost"/);
  const resumesNoCap = new HarnessRegistry([
    new FakeHarness({ harness: "fake-resume", capabilities: { ...FAKE_CAPABILITIES, resumeSession: true } }),
  ]);
  assert.match(
    harnessRefusal(
      { harness: "fake-resume", permission_mode: "acceptEdits", resume_budget_usd: 1 },
      resumesNoCap.lookup,
    ),
    /^resume_budget_usd is not supported by harness fake-resume$/,
    "a resume budget needs a hard budget too",
  );

  const everything = {
    allowed_tools: ["Read"],
    disallowed_tools: ["Edit"],
    permission_mode: "dontAsk",
    on_failure: "resume_once",
    resume_budget_usd: 1,
    max_budget_usd: 2,
    wrap_up_reserve_usd: 0.5,
    max_daily_cost_usd: 3,
    inherit_mcp: true,
    claude_agent: "x",
    add_dirs: ["/tmp"],
    skills: ["s"],
    effort: "high",
    sandbox: true,
    sandbox_allowed_domains: ["github.com"],
    sandbox_weaker_network_isolation: true,
  };
  assert.equal(harnessRefusal(everything, builtinHarnesses), null, "no harness: claude, everything allowed");
  assert.equal(harnessRefusal({ ...everything, harness: "claude" }, builtinHarnesses), null);
  assert.match(harnessRefusal({ harness: "fake" }, builtinHarnesses), /unknown harness "fake"/, "fake ships nowhere");
});

test("create refuses an unknown harness or an unsupported field with the field named, and writes nothing", () => {
  const t = setup();
  try {
    const reload = () => t.runs.reloadConfig();
    const file = path.join(t.config.userAgentsDir, "f.md");
    assert.throws(
      () =>
        createAgentFromFields(
          "own",
          { id: "f", system_prompt: "Hi.", harness: "fake", allowed_tools: ["Read"] },
          t.config,
          reload,
          t.registry.lookup,
        ),
      /agent "f": allowed_tools is not supported by harness fake/,
    );
    assert.throws(
      () => createAgentFromFields("own", { id: "f", system_prompt: "Hi.", harness: "ghost" }, t.config, reload),
      /unknown harness "ghost"/,
    );
    assert.throws(
      () => createAgentFromFields("own", { id: "f", system_prompt: "Hi.", harness: "fake" }, t.config, reload),
      /unknown harness "fake"/,
      "without a registry only the harnesses that ship are known",
    );
    assert.equal(existsSync(file), false, "nothing written");

    const agent = createAgentFromFields(
      "own",
      { id: "f", system_prompt: "Hi.", harness: "fake" },
      t.config,
      reload,
      t.registry.lookup,
    );
    assert.equal(agent.harness, "fake");
    assert.match(readFileSync(file, "utf8"), /^harness: fake$/m);
  } finally {
    t.cleanup();
  }
});

test("start refuses a field the harness cannot honour, before any row or spawn", async () => {
  const t = setup({
    loose: "harness: fake\nallowed_tools: [Read]",
    ghost: "harness: ghost",
    resumer: "harness: fake\non_failure: resume_once",
  });
  try {
    await assert.rejects(
      t.runs.startRun({ agentId: "loose", projectPath: t.project, prompt: "go" }),
      /agent "loose": allowed_tools is not supported by harness fake/,
    );
    await assert.rejects(
      t.runs.startRun({ agentId: "ghost", projectPath: t.project, prompt: "go" }),
      /agent "ghost": unknown harness "ghost"/,
    );
    await assert.rejects(
      t.runs.startRun({ agentId: "resumer", projectPath: t.project, prompt: "go" }),
      /on_failure: resume_once is not supported by harness fake/,
    );
    assert.equal(t.runs.listRuns({ limit: 10 }).length, 0, "no run row");
    assert.equal(t.fake.calls.length + t.fake.prepared.length, 0, "nothing prepared or spawned");
    assert.equal(t.claude.executes, 0);
  } finally {
    t.cleanup();
  }
});

test("a run of another harness goes through its adapter only, ends unpriced and counts as its cap", async () => {
  const t = setup({ other: "harness: fake" });
  try {
    t.runs.setBudget({ scope: "global", amountUsd: 3 });
    const started = await t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "go" });
    assert.equal(started.harness, "fake");
    const run = await t.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");
    assert.equal(run.harness, "fake", "stored on the row");
    assert.equal(run.claudeCodeVersion, "fake 1.0.0", "the harness's own version");
    assert.equal(run.command.binary, t.fake.binary);
    assert.equal(run.costUsd, null);
    assert.equal(run.costStatus, "unpriced", "no dollars reported: unpriced, never 0");
    assert.equal(run.maxBudgetUsd, 2, "the cap it started with: the default, no reserve held back");

    // Claude-only code was never reached: no --max-budget-usd, no MCP restart list, no Claude adapter call.
    assert.equal(t.fake.prepared.length, 1);
    const [request] = t.fake.calls;
    assert.equal(request.maxBudgetUsd, undefined);
    assert.equal(request.requiredMcpServers, undefined);
    assert.equal(request.claudeAgent, undefined);
    assert.equal(t.claude.prepares + t.claude.executes, 0);
    const notes = t.runs
      .events(run.id)
      .filter((e) => e.type === "note")
      .map((e) => e.payload.message);
    assert.ok(notes.includes("fake harness: prepared"), "the adapter's prepare notes reach the timeline");

    // The budget counts the unpriced run at its cap (2 of 3, still under): a second run starts, and
    // once it ended the budget counts 4 of 3, so the third start is refused.
    const [status] = t.runs.budgetStatuses();
    assert.equal(status.unpricedRuns, 1);
    assert.equal(status.countedUsd, 2);
    const second = await t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "again" });
    await t.runs.waitForRun(second.id, 10_000);
    await assert.rejects(t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "third" }), (err) => {
      assert.ok(err instanceof BudgetError, "refused by the budget, not read as $0");
      return true;
    });
  } finally {
    t.cleanup();
  }
});

test("a claude agent next to another harness runs on the Claude adapter, exactly as before", async () => {
  const t = setup({ coder: "permission_mode: acceptEdits" });
  try {
    const started = await t.runs.startRun({ agentId: "coder", projectPath: t.project, prompt: "hello" });
    const run = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(run.harness, "claude");
    assert.equal(run.status, "completed");
    assert.equal(t.claude.prepares, 1);
    assert.equal(t.claude.executes, 1);
    assert.equal(t.fake.calls.length, 0);
    assert.ok(run.command.argv.includes("--max-budget-usd"), "the Claude adapter keeps its budget flag");
  } finally {
    t.cleanup();
  }
});

test("a resume never hands a session to another harness than the one that created it", async () => {
  const resumer = new FakeHarness({
    harness: "fake-resume",
    capabilities: { ...FAKE_CAPABILITIES, resumeSession: true },
  });
  const t = setup({ switcher: "permission_mode: acceptEdits" }, [resumer]);
  try {
    const started = await t.runs.startRun({ agentId: "switcher", projectPath: t.project, prompt: "budget" });
    const first = await t.runs.waitForRun(started.id, 15_000);
    assert.equal(first.harness, "claude");
    assert.equal(first.terminationReason, "budget_exhausted");

    // The agent file moves to another harness that can resume sessions: the Claude session is not its.
    writeFileSync(
      path.join(t.configDir, "agents", "switcher.md"),
      "---\nharness: fake-resume\npermission_mode: acceptEdits\n---\nBe brief.\n",
    );
    const before = t.runs.listRuns({ limit: 10 }).length;
    await assert.rejects(
      t.runs.resumeRun({ runId: first.id }),
      /ran on harness claude, agent "switcher" now uses harness fake-resume/,
    );
    assert.equal(t.runs.listRuns({ limit: 10 }).length, before, "no run row");
    assert.equal(resumer.prepared.length + resumer.calls.length, 0, "nothing prepared or spawned");
  } finally {
    t.cleanup();
  }
});

test("a budget for one run is refused, never dropped, on a harness that cannot stop at a budget", async () => {
  const resumer = new FakeHarness({
    harness: "fake-resume",
    capabilities: { ...FAKE_CAPABILITIES, resumeSession: true },
    result: { outcome: "timed_out", terminationReason: "timed_out" },
  });
  const t = setup({ other: "harness: fake", slow: "harness: fake-resume" }, [resumer]);
  try {
    await assert.rejects(
      t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "go", maxBudgetUsd: 1 }),
      /agent "other": max_budget_usd is not supported by harness fake/,
    );
    await assert.rejects(
      t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "go", kind: "gate", maxBudgetUsd: 1 }),
      /agent "other": gate\.agent\.budget_usd is not supported by harness fake/,
    );
    assert.equal(t.runs.listRuns({ limit: 10 }).length, 0, "no run row");
    assert.equal(t.fake.calls.length + t.fake.prepared.length, 0, "nothing prepared or spawned");

    // A gate without its own budget runs: no Claude gate default is put on the request.
    const gate = await t.runs.startRun({ agentId: "other", projectPath: t.project, prompt: "go", kind: "gate" });
    await t.runs.waitForRun(gate.id, 10_000);
    assert.equal(t.fake.calls[0].maxBudgetUsd, undefined);

    // A timed-out run of a harness that resumes sessions but has no hard budget: an explicit resume
    // budget is refused with the field named; without one the resume starts.
    const first = await t.runs.startRun({ agentId: "slow", projectPath: t.project, prompt: "go" });
    const ended = await t.runs.waitForRun(first.id, 10_000);
    assert.equal(ended.status, "timed_out");
    const before = t.runs.listRuns({ limit: 10 }).length;
    await assert.rejects(
      t.runs.resumeRun({ runId: first.id, budgetUsd: 1 }),
      /agent "slow": budget_usd \(resume budget\) is not supported by harness fake-resume/,
    );
    assert.equal(t.runs.listRuns({ limit: 10 }).length, before, "no run row");
    const resumed = await t.runs.resumeRun({ runId: first.id });
    assert.equal(resumed.resumedFromRunId, first.id);
    await t.runs.waitForRun(resumed.id, 10_000);
  } finally {
    t.cleanup();
  }
});

test("a harness without reportsCostUsd stores no cost, even when its adapter returns 0", async () => {
  const zero = new FakeHarness({ harness: "fake-zero", result: { costUsd: 0 } });
  const t = setup({ cheap: "harness: fake-zero" }, [zero]);
  try {
    const started = await t.runs.startRun({ agentId: "cheap", projectPath: t.project, prompt: "go" });
    const run = await t.runs.waitForRun(started.id, 10_000);
    assert.equal(run.costUsd, null, "a 0 from the adapter is not a reported cost");
    assert.equal(run.costStatus, "unpriced");
  } finally {
    t.cleanup();
  }
});

test("an explicit harness: claude hashes like no harness line", () => {
  const t = setup({ plain: "permission_mode: acceptEdits", explicit: "harness: claude\npermission_mode: acceptEdits" });
  try {
    const plain = t.config.agents.get("plain");
    const explicit = t.config.agents.get("explicit");
    assert.equal(explicit.harness, "claude");
    assert.equal(
      agentDefinitionHash({ ...explicit, id: "plain", name: "plain" }, t.project),
      agentDefinitionHash(plain, t.project),
      "the default harness is left out of the hash",
    );
    assert.notEqual(
      agentDefinitionHash({ ...plain, harness: "fake" }, t.project),
      agentDefinitionHash(plain, t.project),
      "another harness changes it",
    );
  } finally {
    t.cleanup();
  }
});

test("doctor lists each harness; a missing binary matters only when an agent uses it", async () => {
  const t = setup({ other: "harness: fake", lost: "harness: ghost" });
  try {
    const broken = new FakeHarness({ versionError: "spawn /opt/fake-harness/bin/fake ENOENT" });
    const app = { harnesses: new HarnessRegistry([t.claude, broken]), config: t.config };
    const report = await harnessReport(app, { version: "2.1.0 (Claude Code)", error: null });
    assert.deepEqual(
      report.registered.map((r) => [r.name, r.version, r.error !== null, r.agents]),
      [
        ["claude", "2.1.0 (Claude Code)", false, []],
        ["fake", null, true, ["other"]],
      ],
    );
    assert.deepEqual(report.unknown, [{ agentId: "lost", harness: "ghost" }]);

    const plain = { color: false, width: 120, now: new Date() };
    const base = {
      node: "v24",
      claudeBinary: fakeClaude,
      claudeVersion: "2.1.0",
      path: "/usr/bin",
      pathDefaulted: false,
      error: null,
      configDir: "/c",
      configSource: "repo",
      configLookup: { env: null, repo: "/c", user: "/u" },
      dataDir: "/d",
      dataSource: "config",
      agents: ["other", "lost"],
      scheduler: {
        enabled: true,
        ticking: true,
        holder: null,
        service: { supported: false, detail: "n/a" },
        keepAwake: null,
        advice: null,
        duplicateSchedules: [],
      },
      unpricedRuns: [],
      orphans: { recovered: [], advice: null },
    };
    const lines = renderDoctor({ ...base, harnesses: report }, plain);
    const at = lines.findIndex((l) => l.includes("harnesses"));
    assert.deepEqual(report.notInstalled, ["copilot", "codex"], "a shipped harness without its CLI");
    assert.match(
      lines[at],
      /^! harnesses\s+claude 2\.1\.0 \(Claude Code\) · fake missing · copilot not installed · codex not installed$/,
    );
    assert.match(lines[at + 1], /fake \(\/opt\/fake-harness\/bin\/fake\) is not usable, but other run on it: .*ENOENT/);
    assert.match(lines[at + 2], /agent lost sets harness: ghost, which is not registered/);

    const unused = await harnessReport(
      { harnesses: new HarnessRegistry([t.claude, broken]), config: { ...t.config, agents: new Map() } },
      { version: "2.1.0", error: null },
    );
    const quiet = renderDoctor({ ...base, harnesses: unused }, plain);
    assert.ok(
      quiet.some((l) =>
        /^✓ harnesses\s+claude 2\.1\.0 · fake missing · copilot not installed · codex not installed$/.test(l),
      ),
      "an absent binary no agent uses is not a warning",
    );
  } finally {
    t.cleanup();
  }
});
