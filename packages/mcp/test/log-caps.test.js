/**
 * Log caps (claude.max_event_bytes, claude.max_log_bytes) and the log metadata stored on the run
 * (log_bytes, log_sha256, log_truncated; migration 25). Fake claude, temp directories.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import "./helpers.js"; // before @duskfleet/core: drops an inherited CLAUDE_BIN

import {
  CappedLogWriter,
  ClaudeCodeExecutor,
  capEventJson,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_LOG_BYTES,
  LOG_TRUNCATED_LINE,
  loadConfig,
  openDatabase,
  RunManager,
  RunRepository,
} from "@duskfleet/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBinary = path.join(here, "fake-claude.js");
const BIG = 200 * 1024;

function makeApp(claudeYaml = "") {
  const root = mkdtempSync(path.join(tmpdir(), "duskfleet-logcaps-"));
  const configDir = path.join(root, "config");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const project = path.join(root, "project");
  mkdirSync(project);
  writeFileSync(
    path.join(configDir, "duskfleet.yaml"),
    `data_dir: ../data\nallowed_project_roots: ["${root}"]\ndefault_agent: coder\nclaude:\n  binary: "${fakeBinary}"\n  default_timeout_minutes: 0.1\n${claudeYaml}`,
  );
  writeFileSync(path.join(configDir, "agents", "coder.md"), `---\npermission_mode: acceptEdits\n---\nBe brief.\n`);
  const config = loadConfig(configDir);
  const db = openDatabase(config.dataDir);
  const repo = new RunRepository(db);
  const executor = new ClaudeCodeExecutor({ binary: config.claude.binary, strictMcpConfig: true });
  const runs = new RunManager(config, repo, executor);
  const cleanup = async () => {
    runs.shutdown();
    await new Promise((r) => setTimeout(r, 200));
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return { root, config, db, repo, project: realpathSync(project), runs, cleanup };
}

/** Every stored payload of a run, as the raw JSON text in run_events. */
function storedPayloads(db, runId) {
  return db.prepare("SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY id").all(runId);
}

test("config: the caps default to 64 KiB per event and 50 MiB per log, and can be set", async () => {
  const plain = makeApp();
  const set = makeApp("  max_event_bytes: 4096\n  max_log_bytes: 2048\n");
  try {
    assert.equal(plain.config.claude.maxEventBytes, 65536);
    assert.equal(DEFAULT_MAX_EVENT_BYTES, 65536);
    assert.equal(plain.config.claude.maxLogBytes, 50 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_LOG_BYTES, 52428800);
    assert.equal(set.config.claude.maxEventBytes, 4096);
    assert.equal(set.config.claude.maxLogBytes, 2048);
  } finally {
    await plain.cleanup();
    await set.cleanup();
  }
});

test("capEventJson: a payload under the cap is stored as it is", () => {
  const payload = { name: "Read", summary: "file.txt" };
  assert.equal(capEventJson(payload, 65536), JSON.stringify(payload));
});

test("capEventJson: a 200 KiB content string is cut with the marker, the envelope kept, truncated: true", () => {
  const payload = { type: "tool_result", toolUseId: "toolu_big", name: "Read", content: "x".repeat(BIG) };
  const json = capEventJson(payload, 65536);
  assert.ok(Buffer.byteLength(json) <= 65536, `stored ${Buffer.byteLength(json)} bytes`);
  const stored = JSON.parse(json);
  assert.equal(stored.type, "tool_result");
  assert.equal(stored.toolUseId, "toolu_big");
  assert.equal(stored.name, "Read");
  assert.equal(stored.truncated, true);
  const m = /^(x+)…\[truncated (\d+) bytes\]$/.exec(stored.content);
  assert.ok(m, "content ends with the marker");
  assert.ok(m[1].length > 60_000, "keeps most of the cap");
  assert.equal(m[1].length + Number(m[2]), BIG, "kept + dropped = original");
});

test("capEventJson: nested and multi-byte strings stay under the cap without broken characters", () => {
  const payload = { type: "note", detail: { lines: ["é".repeat(50_000), "😀".repeat(30_000)] }, id: "n1" };
  const json = capEventJson(payload, 8192);
  assert.ok(Buffer.byteLength(json) <= 8192);
  const stored = JSON.parse(json);
  assert.equal(stored.id, "n1");
  assert.equal(stored.truncated, true);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored.detail.lines[1]), "no lone high surrogate");
});

test("capEventJson: a non-object payload over the cap becomes { truncated, bytes, preview }", () => {
  const json = capEventJson("y".repeat(BIG), 4096);
  assert.ok(Buffer.byteLength(json) <= 4096);
  const stored = JSON.parse(json);
  assert.equal(stored.truncated, true);
  assert.equal(stored.bytes, BIG + 2);
  assert.match(stored.preview, /…\[truncated \d+ bytes\]$/);
});

test("capEventJson: an over-cap payload of short strings keeps its envelope, the big array stubbed", () => {
  const changedFiles = Array.from({ length: 2000 }, (_, i) => `src/file-${i}.ts`);
  const payload = { type: "diff", name: "git", filesChanged: 2000, changedFiles };
  const json = capEventJson(payload, 4096);
  assert.ok(Buffer.byteLength(json) <= 4096);
  const stored = JSON.parse(json);
  assert.equal(stored.type, "diff");
  assert.equal(stored.name, "git");
  assert.equal(stored.filesChanged, 2000);
  assert.equal(stored.truncated, true);
  assert.deepEqual(stored.changedFiles, { truncated: true, bytes: Buffer.byteLength(JSON.stringify(changedFiles)) });
});

test("RunRepository.addEvent stores an oversized payload capped at max_event_bytes", async () => {
  const app = makeApp("  max_event_bytes: 65536\n");
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    await app.runs.waitForRun(started.id, 10_000);
    app.repo.addEvent(started.id, "note", { message: "big", content: "z".repeat(BIG) });
    const row = storedPayloads(app.db, started.id).at(-1);
    assert.ok(Buffer.byteLength(row.payload) <= 65536);
    const note = app.runs.events(started.id).at(-1).payload;
    assert.equal(note.message, "big");
    assert.equal(note.truncated, true);
    assert.match(note.content, /…\[truncated \d+ bytes\]$/);
  } finally {
    await app.cleanup();
  }
});

test("RunRepository.addEvent stores the diff event uncapped, so diff() keeps changedFiles an array", async () => {
  const app = makeApp("  max_event_bytes: 1024\n");
  try {
    const started = await app.runs.startRun({ prompt: "ok", projectPath: app.project });
    await app.runs.waitForRun(started.id, 10_000);
    const changedFiles = Array.from({ length: 40 }, (_, i) => ({
      path: `src/some/module-${i}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const diff = {
      base: "a".repeat(40),
      head: null,
      additions: 40,
      deletions: 0,
      totalsPartial: false,
      filesChanged: 40,
      changedFiles,
      filesTruncated: false,
      patchPath: null,
      patchBytes: 0,
      patchTruncated: false,
    };
    app.repo.addEvent(started.id, "diff", diff);
    assert.ok(Buffer.byteLength(JSON.stringify(diff)) > 1024);
    const stored = app.repo.diff(started.id);
    assert.ok(Array.isArray(stored.changedFiles));
    assert.deepEqual(stored, diff);
  } finally {
    await app.cleanup();
  }
});

test("a 200 KiB tool_result: the JSONL line is whole, no stored event passes the cap, size and sha256 recorded", async () => {
  const app = makeApp();
  try {
    const started = await app.runs.startRun({ prompt: "big-tool-result", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed");

    const raw = readFileSync(run.logPath);
    const lines = raw.toString("utf8").trimEnd().split("\n");
    const big = lines.map((l) => JSON.parse(l)).find((o) => o.type === "user" && JSON.stringify(o).length > BIG);
    assert.ok(big, "the tool_result line is in the log");
    assert.equal(big.message.content[0].content.length, BIG, "written in full");

    for (const row of storedPayloads(app.db, run.id)) {
      assert.ok(Buffer.byteLength(row.payload ?? "") <= 65536, `${row.type} within the cap`);
    }

    assert.equal(run.logBytes, statSync(run.logPath).size);
    assert.equal(run.logSha256, createHash("sha256").update(raw).digest("hex"));
    assert.equal(run.logTruncated, false);
  } finally {
    await app.cleanup();
  }
});

test("a log over max_log_bytes ends with the marker line, log_truncated = 1, events all in run_events", async () => {
  const app = makeApp("  max_log_bytes: 4096\n");
  try {
    const started = await app.runs.startRun({ prompt: "big-tool-result", projectPath: app.project });
    const run = await app.runs.waitForRun(started.id, 10_000);
    assert.equal(run.status, "completed", "the run keeps going past the cap");

    const text = readFileSync(run.logPath, "utf8");
    assert.ok(text.endsWith(LOG_TRUNCATED_LINE), "last line is the marker");
    assert.equal(text.split(LOG_TRUNCATED_LINE).length, 2, "marker written once");
    assert.deepEqual(JSON.parse(LOG_TRUNCATED_LINE), {
      type: "duskfleet_log_truncated",
      bytes_dropped_from_here: true,
    });
    assert.ok(Buffer.byteLength(text) <= 4096 + LOG_TRUNCATED_LINE.length);
    assert.equal(run.logTruncated, true);
    assert.equal(run.logBytes, Buffer.byteLength(text));

    // Everything after the cut still reached the database: both tool calls, the end of the run.
    const types = app.runs.events(run.id).map((e) => e.type);
    assert.equal(types.filter((t) => t === "tool_use").length, 2);
    assert.ok(types.includes("init"));
    assert.deepEqual(app.runs.events(run.id).at(-1).payload, { from: "running", to: "completed" });
    assert.equal(run.toolCalls, 2);
    assert.equal(run.resultText, "Done: created hello.txt");
  } finally {
    await app.cleanup();
  }
});

test("CappedLogWriter: a file already at its cap is not written again, and keeps a single marker", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "duskfleet-logwriter-"));
  try {
    const file = path.join(dir, "logs", "run.jsonl");
    const first = new CappedLogWriter(file, 1024, () => {});
    first.write(`${"a".repeat(1000)}\n`);
    first.write(`${"b".repeat(100)}\n`);
    assert.equal(first.truncated, true);
    await first.end();
    const size = statSync(file).size;

    // A second pass of the same run (wrap-up) appends to the same file.
    const second = new CappedLogWriter(file, 1024, () => {});
    assert.equal(second.truncated, true);
    second.write("more\n");
    await second.end();
    assert.equal(statSync(file).size, size, "nothing appended");
    assert.equal(readFileSync(file, "utf8").split(LOG_TRUNCATED_LINE).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CappedLogWriter: a reopened log that ends with the marker below its cap is not appended to", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "duskfleet-logwriter-"));
  try {
    const file = path.join(dir, "logs", "run.jsonl");
    const first = new CappedLogWriter(file, 1000, () => {});
    first.write(`${"a".repeat(899)}\n`);
    first.write(`${"b".repeat(299)}\n`);
    assert.equal(first.truncated, true);
    await first.end();
    const size = statSync(file).size;
    assert.ok(size < 1000, "the marker ends the file below the cap");

    const second = new CappedLogWriter(file, 1000, () => {});
    assert.equal(second.truncated, true);
    second.write("more\n");
    await second.end();
    assert.equal(statSync(file).size, size, "nothing appended after the marker");
    assert.ok(readFileSync(file, "utf8").endsWith(LOG_TRUNCATED_LINE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
